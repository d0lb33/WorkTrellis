import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const IS_WINDOWS = process.platform === "win32";

/**
 * PATH lookup without shelling out to `which`/`where`. Honors PATHEXT so
 * `docker` resolves to `docker.exe` on Windows.
 */
export function whichSync(command: string): string | null {
  if (command.includes("/") || command.includes("\\")) {
    return fs.existsSync(command) ? command : null;
  }

  const searchPath = process.env.PATH ?? process.env.Path ?? "";
  const extensions = IS_WINDOWS
    ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];

  for (const dir of searchPath.split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(dir, `${command}${extension}`);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // Unreadable PATH entry; keep looking.
      }
    }
  }

  return null;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Capture stdout/stderr instead of streaming them to the terminal. */
  capture?: boolean;
  /** Capture and discard — used for probe commands. */
  quiet?: boolean;
  /** Allow a delegated tool to perform its own interactive setup. */
  stdin?: "ignore" | "inherit";
  timeoutMs?: number;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Spawn a real executable and wait for it. Never uses a shell, so arguments
 * containing spaces are safe on every platform and there is nothing to quote.
 */
export function run(
  command: string,
  args: string[],
  options: RunOptions = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const capture = options.capture === true || options.quiet === true;

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: capture
        ? [options.stdin ?? "ignore", "pipe", "pipe"]
        : [options.stdin ?? "ignore", "inherit", "inherit"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          if (child.pid) killTree(child.pid, "SIGKILL");
        }, options.timeoutMs)
      : null;

    child.once("error", (caught) => {
      if (timer) clearTimeout(timer);
      reject(caught);
    });

    child.once("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr, timedOut });
    });
  });
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (caught) {
    // EPERM means the process exists but belongs to another user.
    return (caught as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Kill a process AND everything it spawned.
 *
 * This is why WorkTrellis supervises its own children: `next dev` and
 * `tsx --watch` both fork, and signalling only the direct child leaves orphans
 * holding ports. On Windows `taskkill /T` asks the operating system to walk
 * the tree; on POSIX the negative pid targets the process group created by
 * `detached: true`.
 */
export function killTree(
  pid: number,
  signal: NodeJS.Signals = "SIGTERM",
): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;

  if (IS_WINDOWS) {
    const force = signal === "SIGKILL";
    const args = ["/pid", String(pid), "/T"];
    if (force) args.push("/F");
    const result = spawnSync(
      resolveWindowsSystemExecutable("taskkill.exe"),
      args,
      {
        stdio: "ignore",
        windowsHide: true,
      },
    );
    return result.status === 0;
  }

  // A well-behaved wrapper handles SIGTERM and shuts down its own children.
  // Force cleanup has no such cooperation, so snapshot verified descendants
  // before killing the parent; nested tools may create their own process groups
  // that a single negative-PID signal cannot reach.
  if (signal === "SIGKILL") {
    for (const descendant of descendantPids(pid)) {
      signalProcessOrGroup(descendant, signal);
    }
  }

  return signalProcessOrGroup(pid, signal);
}

/**
 * Give a foreground wrapper a chance to observe its application exiting and
 * run provider-owned cleanup.
 *
 * POSIX wrappers can receive SIGTERM directly. Windows cannot deliver an
 * equivalent catchable signal to another console process, so terminate only
 * the wrapper's direct child trees. A wrapper such as Portless then observes
 * its child exit and cleans up routes/tunnels before exiting itself. If no
 * children can be found, leave the root alone for the caller's bounded grace
 * period rather than interrupt cleanup that may already be in progress.
 */
export function requestCooperativeTreeShutdown(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return;

  if (!IS_WINDOWS) {
    killTree(pid, "SIGTERM");
    return;
  }

  for (const childPid of directWindowsChildPids(pid)) {
    // Windows has no catchable cross-process SIGTERM. Force the owned app
    // subtree while deliberately preserving its supervising wrapper.
    killTree(childPid, "SIGKILL");
  }
}

function signalProcessOrGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

export function resolveWindowsSystemExecutable(name: string): string {
  const systemRoot = process.env.SystemRoot?.trim();
  if (!systemRoot) return name;
  const candidate = path.join(systemRoot, "System32", name);
  return fs.existsSync(candidate) ? candidate : name;
}

function windowsPowerShellExecutable(): string {
  const systemRoot = process.env.SystemRoot?.trim();
  if (systemRoot) {
    const candidate = path.join(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    if (fs.existsSync(candidate)) return candidate;
  }
  return "powershell";
}

function directWindowsChildPids(rootPid: number): number[] {
  const result = spawnSync(
    windowsPowerShellExecutable(),
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Get-CimInstance Win32_Process -Filter "ParentProcessId = ${rootPid}" | ForEach-Object { $_.ProcessId }`,
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
    },
  );
  if (result.status !== 0 || !result.stdout) return [];

  return result.stdout
    .split(/\r?\n/)
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

function descendantPids(rootPid: number): number[] {
  const result = spawnSync("ps", ["-axo", "pid=,ppid="], {
    encoding: "utf8",
    timeout: 15_000,
  });
  if (result.status !== 0 || !result.stdout) return [];

  const children = new Map<number, number[]>();
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match) continue;
    const pid = Number.parseInt(match[1]!, 10);
    const parentPid = Number.parseInt(match[2]!, 10);
    if (!Number.isInteger(pid) || !Number.isInteger(parentPid)) continue;
    const siblings = children.get(parentPid) ?? [];
    siblings.push(pid);
    children.set(parentPid, siblings);
  }

  const descendants: number[] = [];
  const visited = new Set<number>([rootPid]);
  const visit = (parentPid: number): void => {
    for (const childPid of children.get(parentPid) ?? []) {
      if (visited.has(childPid)) continue;
      visited.add(childPid);
      visit(childPid);
      descendants.push(childPid);
    }
  };
  visit(rootPid);
  return descendants;
}

export interface ProcessDescription {
  pid: number;
  parentPid: number | null;
  commandLine: string;
  /** Epoch ms, when the platform reports it. */
  startedAt: number | null;
}

/**
 * Best-effort description of live processes, used to confirm a recorded pid
 * really belongs to this worktree before killing it — pids get recycled, and an
 * unverified kill of a reused pid would take down an unrelated program.
 *
 * Returns an empty map when the platform tooling is unavailable; callers must
 * treat "cannot verify" as "do not kill".
 */
export function describeProcesses(
  pids: number[],
): Map<number, ProcessDescription> {
  const described = new Map<number, ProcessDescription>();
  const alive = pids.filter((pid) => isProcessAlive(pid));
  if (alive.length === 0) return described;

  if (IS_WINDOWS) {
    const filter = alive.map((pid) => `ProcessId=${pid}`).join(" or ");
    const result = spawnSync(
      windowsPowerShellExecutable(),
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Get-CimInstance Win32_Process -Filter "${filter}" | ForEach-Object { "$($_.ProcessId)\`t$($_.ParentProcessId)\`t$($_.CreationDate.ToFileTimeUtc())\`t$($_.CommandLine)" }`,
      ],
      { encoding: "utf8", windowsHide: true, timeout: 15_000 },
    );

    if (result.status === 0 && result.stdout) {
      for (const line of result.stdout.split(/\r?\n/)) {
        const [rawPid, rawParentPid, rawFileTime, ...rest] = line.split("\t");
        const pid = Number.parseInt(rawPid ?? "", 10);
        if (!Number.isInteger(pid)) continue;
        const parsedParentPid = Number.parseInt(rawParentPid ?? "", 10);
        // Windows FILETIME: 100ns ticks since 1601-01-01.
        const fileTime = Number(rawFileTime);
        const startedAt = Number.isFinite(fileTime)
          ? Math.round(fileTime / 10_000 - 11_644_473_600_000)
          : null;
        described.set(pid, {
          pid,
          parentPid:
            Number.isInteger(parsedParentPid) && parsedParentPid > 0
              ? parsedParentPid
              : null,
          commandLine: rest.join("\t"),
          startedAt,
        });
      }
    }

    return described;
  }

  const result = spawnSync(
    "ps",
    ["-o", "pid=,ppid=,lstart=,command=", "-p", alive.join(",")],
    { encoding: "utf8", timeout: 15_000 },
  );

  if (result.status === 0 && result.stdout) {
    for (const line of result.stdout.split("\n")) {
      // pid, ppid, then a fixed-width 24-char `lstart`, then the command.
      const match = /^\s*(\d+)\s+(\d+)\s+(.{24})\s(.*)$/.exec(line);
      if (!match) continue;
      const pid = Number.parseInt(match[1] ?? "", 10);
      const parentPid = Number.parseInt(match[2] ?? "", 10);
      if (!Number.isInteger(pid)) continue;
      const parsed = Date.parse(match[3] ?? "");
      described.set(pid, {
        pid,
        parentPid:
          Number.isInteger(parentPid) && parentPid > 0 ? parentPid : null,
        commandLine: match[4] ?? "",
        startedAt: Number.isFinite(parsed) ? parsed : null,
      });
    }
  }

  return described;
}

/** Identify listeners without killing them. Callers must verify ownership. */
export function listeningProcessIds(port: number): number[] {
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) return [];

  if (IS_WINDOWS) {
    const powershell = spawnSync(
      windowsPowerShellExecutable(),
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique`,
      ],
      { encoding: "utf8", windowsHide: true, timeout: 15_000 },
    );
    if (powershell.status === 0) {
      return parseProcessIds(powershell.stdout ?? "");
    }

    const result = spawnSync(
      resolveWindowsSystemExecutable("netstat.exe"),
      ["-ano", "-p", "tcp"],
      { encoding: "utf8", windowsHide: true, timeout: 15_000 },
    );
    if (result.status !== 0 || !result.stdout) return [];
    return parseWindowsListeningProcessIds(result.stdout, port);
  }

  const result = spawnSync(
    "lsof",
    ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
    { encoding: "utf8", timeout: 15_000 },
  );
  if (result.status !== 0 || !result.stdout) return [];
  return parseProcessIds(result.stdout);
}

export function parseProcessIds(output: string): number[] {
  return [
    ...new Set(
      output
        .split(/\r?\n/)
        .map((value) => Number.parseInt(value.trim(), 10))
        .filter((pid) => Number.isInteger(pid) && pid > 0),
    ),
  ];
}

export function parseWindowsListeningProcessIds(
  output: string,
  port: number,
): number[] {
  const pids = new Set<number>();
  for (const line of output.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 5 || columns[0]?.toUpperCase() !== "TCP") continue;
    if (columns[3]?.toUpperCase() !== "LISTENING") continue;
    const localAddress = columns[1] ?? "";
    const separator = localAddress.lastIndexOf(":");
    if (separator === -1) continue;
    if (Number.parseInt(localAddress.slice(separator + 1), 10) !== port) continue;
    const pid = Number.parseInt(columns[4] ?? "", 10);
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}
