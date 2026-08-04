import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

import type { Command, EnvContext, ProcessSpec } from "../types";
import { WorkTrellisError } from "../core/errors";
import { redactDiagnosticText } from "../core/env-resolve";
import { ensureDirectory } from "../util/fs";
import { c, info, NAMED_COLORS, PROCESS_COLORS, type Colorize } from "../util/log";
import { canConnect } from "../platform/ports";
import { killTree, requestCooperativeTreeShutdown } from "../util/proc";
import { writeRunRecord, type RunChild, type RunRecord } from "./reaper";
import {
  clearShutdownRequest,
  consumeShutdownRequest,
} from "./shutdown";

/**
 * Runs the project's dev processes and guarantees they all die together.
 *
 * Two rules drive the implementation:
 *   - never involve a shell, and never spawn a `.cmd` shim: resolve the real
 *     JavaScript entry point and run it with this Node binary, so the pid we
 *     hold is the process we need to kill;
 *   - always kill the whole tree, because dev servers and file watchers fork.
 */

export interface SupervisedProcess {
  spec: ProcessSpec;
  color: Colorize;
  child: ChildProcess | null;
  pid: number | null;
  restarts: number;
  state: "starting" | "running" | "ready" | "stopped" | "failed";
  startedAt: number;
  exitCode: number | null;
}

export interface SupervisorOptions {
  projectRoot: string;
  env: Record<string, string>;
  envContext: EnvContext;
  runFile: string;
  stopFile?: string;
  logDirectory: string;
  identity: { project: string; slug: string; root: string };
  aliases: string[];
  prefix?: boolean;
  /** Stream this process's output untouched, for tools with live redraws. */
  raw?: string;
  /** Maximum cooperative cleanup window before owned processes are killed. */
  cooperativeShutdownGraceMs?: number;
  /** Observe already-sanitized child output without taking over supervision. */
  onOutputLine?: (event: { process: string; line: string }) => void;
}

const RESTART_WINDOW_MS = 60_000;
const STARTUP_GRACE_MS = 3_000;
const DEFAULT_MAX_RESTARTS = 5;

/**
 * A supervised child shares the terminal with its siblings. Destructive screen
 * controls therefore cannot be honored in multiplexed mode: a watcher restart
 * must not erase the app's output. SGR color controls remain untouched.
 */
export function sanitizeMultiplexedOutput(value: string): string {
  return value
    .replace(/\u001bc/g, "")
    .replace(/\u001b\[(?:[0-9;?]*[HJf]|[0-9;]*[JK])/g, "");
}

/** Keep Windows wrappers out of Git Bash's console-wide Ctrl+C broadcast. */
export function supervisedProcessIsolation(): {
  detached: true;
  windowsHide: true;
} {
  return { detached: true, windowsHide: true };
}

function resolveCommand(
  command: Command,
  projectRoot: string,
): { file: string; args: string[] } {
  if ("node" in command) {
    const [entry, ...rest] = command.node;
    if (!entry) throw new WorkTrellisError("A `node` command needs an entry point.");
    return {
      file: process.execPath,
      args: [path.resolve(projectRoot, entry), ...rest],
    };
  }

  return { file: command.bin, args: command.args };
}

export class Supervisor {
  private readonly options: SupervisorOptions;
  private readonly processes = new Map<string, SupervisedProcess>();
  private readonly logStreams = new Map<string, fs.WriteStream>();
  private readonly restartTimestamps = new Map<string, number[]>();
  private shuttingDown = false;
  private stopped: ((code: number) => void) | null = null;
  private stopRequestTimer: NodeJS.Timeout | null = null;
  private readonly startedAtMs = Math.round(
    Date.now() - process.uptime() * 1_000,
  );
  private labelWidth = 6;

  constructor(options: SupervisorOptions) {
    this.options = options;
    ensureDirectory(options.logDirectory);
  }

  add(spec: ProcessSpec, index: number): void {
    const color =
      (spec.color ? NAMED_COLORS[spec.color] : undefined) ??
      PROCESS_COLORS[index % PROCESS_COLORS.length]!;

    this.processes.set(spec.name, {
      spec,
      color,
      child: null,
      pid: null,
      restarts: 0,
      state: "starting",
      startedAt: 0,
      exitCode: null,
    });

    this.labelWidth = Math.max(this.labelWidth, spec.name.length);
  }

  /** Start everything and resolve when the run ends. */
  async run(): Promise<number> {
    // Install the resolver before starting anything. A dependency can fail
    // while a later process is waiting for readiness; shutdown must still have
    // a completion promise to resolve in that path.
    const completion = new Promise<number>((resolve) => {
      this.stopped = resolve;
    });
    this.prepareForRun();

    // Start in dependency order, waiting for each dependency to report ready
    // before its dependents launch.
    for (const entry of this.startOrder()) {
      for (const dependency of entry.spec.dependsOn ?? []) {
        const target = this.processes.get(dependency);
        if (target) await this.waitUntilReady(target);
      }
      if (this.shuttingDown) break;
      this.start(entry);
      this.persistRunRecord();
    }

    this.finishIfAllStopped();
    return completion;
  }

  get supervisorStartedAt(): number {
    return this.startedAtMs;
  }

  /** Persist the supervisor identity before live state makes the run visible. */
  prepareForRun(): void {
    this.startStopRequestWatcher();
    this.persistRunRecord();
  }

  private startStopRequestWatcher(): void {
    const stopFile = this.options.stopFile;
    if (!stopFile || this.stopRequestTimer) return;

    clearShutdownRequest(stopFile);
    this.stopRequestTimer = setInterval(() => {
      const requested = consumeShutdownRequest(stopFile, {
        supervisorPid: process.pid,
        supervisorStartedAt: this.startedAtMs,
      });
      if (requested) void this.shutdown(0);
    }, 100);
  }

  private stopStopRequestWatcher(): void {
    if (this.stopRequestTimer) {
      clearInterval(this.stopRequestTimer);
      this.stopRequestTimer = null;
    }
    if (this.options.stopFile) clearShutdownRequest(this.options.stopFile);
  }

  /** Topological order over the already-validated `dependsOn` graph. */
  private startOrder(): SupervisedProcess[] {
    const ordered: SupervisedProcess[] = [];
    const visiting = new Set<string>();
    const done = new Set<string>();

    const visit = (entry: SupervisedProcess): void => {
      if (done.has(entry.spec.name) || visiting.has(entry.spec.name)) return;
      visiting.add(entry.spec.name);

      for (const dependency of entry.spec.dependsOn ?? []) {
        const target = this.processes.get(dependency);
        if (target) visit(target);
      }

      visiting.delete(entry.spec.name);
      done.add(entry.spec.name);
      ordered.push(entry);
    };

    for (const entry of this.processes.values()) visit(entry);
    return ordered;
  }

  /**
   * Resolve once a process is usable by its dependents.
   *
   * Readiness is whichever of these is configured: a matching log line, an
   * accepting port, or simply having started. A timeout is not fatal — the
   * dependent starts anyway, with a warning, because blocking the whole run on
   * a readiness heuristic is worse than starting slightly early.
   */
  private async waitUntilReady(entry: SupervisedProcess): Promise<void> {
    const check = entry.spec.readyWhen;
    if (!check) return;

    const timeoutMs = check.timeoutMs ?? 60_000;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (this.shuttingDown) return;
      if (entry.state === "failed" || entry.state === "stopped") return;
      if (entry.state === "ready") return;

      if (check.port && (await canConnect(check.port, "127.0.0.1", 500))) {
        entry.state = "ready";
        return;
      }

      // Nothing to observe: treat "running" as ready rather than stall.
      if (!check.logMatch && !check.port && entry.state === "running") return;

      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    this.write(
      entry,
      c.yellow(
        `did not report ready within ${Math.round(timeoutMs / 1000)}s; starting dependents anyway`,
      ),
    );
  }

  private start(entry: SupervisedProcess): void {
    const { file, args } = resolveCommand(
      typeof entry.spec.command === "function"
        ? entry.spec.command(this.options.envContext)
        : entry.spec.command,
      this.options.projectRoot,
    );

    const env = {
      ...process.env,
      ...this.options.env,
      ...(entry.spec.env?.(this.options.envContext) ?? {}),
      FORCE_COLOR: process.env.FORCE_COLOR ?? "1",
    };

    const child = spawn(file, args, {
      cwd: this.options.projectRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      // POSIX uses the new process group for tree signals. Windows uses a
      // hidden, separate console so Git Bash's console-wide Ctrl+C reaches the
      // WorkTrellis supervisor but not every nested wrapper independently.
      ...supervisedProcessIsolation(),
    });

    entry.child = child;
    entry.pid = child.pid ?? null;
    entry.state = "running";
    entry.startedAt = Date.now();
    entry.exitCode = null;

    this.pipe(entry, child, "stdout");
    this.pipe(entry, child, "stderr");

    child.once("error", (caught) => {
      this.write(
        entry,
        `failed to start: ${redactDiagnosticText(caught.message, env)}`,
      );
      entry.state = "failed";
      this.onExit(entry, 1);
    });

    child.once("exit", (code, signal) => {
      this.onExit(entry, code ?? (signal ? 143 : 0));
    });
  }

  private pipe(
    entry: SupervisedProcess,
    child: ChildProcess,
    stream: "stdout" | "stderr",
  ): void {
    const source = child[stream];
    if (!source) return;

    const decoder = new StringDecoder("utf8");
    let buffer = "";

    source.on("data", (chunk: Buffer) => {
      if (this.options.raw === entry.spec.name) {
        process.stdout.write(chunk);
        this.log(entry, chunk.toString());
        return;
      }

      buffer += decoder.write(chunk);

      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        this.write(entry, line);
        newline = buffer.indexOf("\n");
      }

      // Carriage-return progress output never terminates a line; flush it so a
      // dev server's startup banner is not withheld indefinitely.
      if (buffer.length > 4096) {
        this.write(entry, buffer);
        buffer = "";
      }
    });

    source.on("end", () => {
      if (buffer.length > 0) {
        this.write(entry, buffer);
        buffer = "";
      }
    });
  }

  private write(entry: SupervisedProcess, line: string): void {
    const safeLine = sanitizeMultiplexedOutput(line);
    if (line.length > 0 && safeLine.length === 0) return;

    this.log(entry, `${safeLine}\n`);

    try {
      this.options.onOutputLine?.({ process: entry.spec.name, line: safeLine });
    } catch {
      // Diagnostics and provider metadata must never break process supervision.
    }

    if (this.checkReady(entry, safeLine)) {
      entry.state = "ready";
    }

    if (this.options.prefix === false) {
      info(safeLine);
      return;
    }

    const label = entry.color(entry.spec.name.padEnd(this.labelWidth));
    info(`${label} ${c.gray("|")} ${safeLine}`);
  }

  private checkReady(entry: SupervisedProcess, line: string): boolean {
    const match = entry.spec.readyWhen?.logMatch;
    return entry.state === "running" && match !== undefined && match.test(line);
  }

  private log(entry: SupervisedProcess, text: string): void {
    let stream = this.logStreams.get(entry.spec.name);
    if (!stream) {
      stream = fs.createWriteStream(
        path.join(this.options.logDirectory, `${entry.spec.name}.log`),
        { flags: "w" },
      );
      this.logStreams.set(entry.spec.name, stream);
    }
    stream.write(text);
  }

  private onExit(entry: SupervisedProcess, code: number): void {
    entry.exitCode = code;
    entry.child = null;
    entry.pid = null;

    if (this.shuttingDown) {
      entry.state = "stopped";
      this.finishIfAllStopped();
      return;
    }

    const uptime = Date.now() - entry.startedAt;

    // A process that dies almost immediately is misconfigured, not crashed.
    // Restarting it would just loop; failing fast surfaces the real error.
    if (uptime < STARTUP_GRACE_MS) {
      this.write(entry, c.red(`exited with code ${code} during startup`));
      entry.state = "failed";
      void this.shutdown(code === 0 ? 1 : code);
      return;
    }

    const policy = entry.spec.restart ?? "on-crash";
    if (policy === "never" || code === 0) {
      entry.state = "stopped";
      this.write(entry, c.gray(`exited with code ${code}`));
      void this.shutdown(code);
      return;
    }

    if (!this.canRestart(entry)) {
      this.write(
        entry,
        c.red(`exited with code ${code} and exceeded its restart budget`),
      );
      entry.state = "failed";
      void this.shutdown(code);
      return;
    }

    entry.restarts += 1;
    const delay = Math.min(500 * 2 ** (entry.restarts - 1), 8_000);
    this.write(
      entry,
      c.yellow(`exited with code ${code}; restarting in ${delay}ms`),
    );

    setTimeout(() => {
      if (!this.shuttingDown) {
        this.start(entry);
        this.persistRunRecord();
      }
    }, delay);
  }

  private canRestart(entry: SupervisedProcess): boolean {
    const max = entry.spec.maxRestarts ?? DEFAULT_MAX_RESTARTS;
    const now = Date.now();
    const recent = (this.restartTimestamps.get(entry.spec.name) ?? []).filter(
      (stamp) => now - stamp < RESTART_WINDOW_MS,
    );
    recent.push(now);
    this.restartTimestamps.set(entry.spec.name, recent);
    return recent.length <= max;
  }

  private finishIfAllStopped(): void {
    const running = [...this.processes.values()].some(
      (entry) => entry.child !== null,
    );
    if (running) return;

    this.stopStopRequestWatcher();
    for (const stream of this.logStreams.values()) stream.end();
    const resolve = this.stopped;
    this.stopped = null;
    resolve?.(this.exitCode);
  }

  private exitCode = 0;

  /** Stop every process and its descendants. Safe to call more than once. */
  async shutdown(code = 0): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.exitCode = code;

    const live = [...this.processes.values()].filter((entry) => entry.pid !== null);

    for (const entry of live) {
      if (entry.pid) requestCooperativeTreeShutdown(entry.pid);
    }

    // Give wrappers time to finish their own cleanup, returning as soon as
    // they do instead of holding the supervisor open for the full window.
    const deadline =
      Date.now() + (this.options.cooperativeShutdownGraceMs ?? 3_000);
    while (
      [...this.processes.values()].some((entry) => entry.pid !== null) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    for (const entry of this.processes.values()) {
      if (entry.pid) killTree(entry.pid, "SIGKILL");
    }

    this.finishIfAllStopped();
  }

  /** Last-resort synchronous kill, for `process.on("exit")`. */
  killAllSync(): void {
    for (const entry of this.processes.values()) {
      if (entry.pid) killTree(entry.pid, "SIGKILL");
    }
  }

  snapshot(): SupervisedProcess[] {
    return [...this.processes.values()];
  }

  private persistRunRecord(): void {
    const children: RunChild[] = [];

    for (const entry of this.processes.values()) {
      if (entry.pid === null) continue;
      children.push({
        name: entry.spec.name,
        pid: entry.pid,
        startedAtMs: entry.startedAt,
        // Every child runs from the project root, so its command line contains
        // that path. That is what proves a pid is ours on the next run.
        cmdMustContain: this.options.projectRoot,
      });
    }

    const record: RunRecord = {
      supervisorPid: process.pid,
      supervisorStartedAt: this.startedAtMs,
      project: this.options.identity.project,
      slug: this.options.identity.slug,
      worktreeRoot: this.options.identity.root,
      aliases: this.options.aliases,
      ...(this.options.cooperativeShutdownGraceMs !== undefined
        ? {
            cooperativeShutdownGraceMs:
              this.options.cooperativeShutdownGraceMs,
          }
        : {}),
      children,
    };

    writeRunRecord(this.options.runFile, record);
  }
}
