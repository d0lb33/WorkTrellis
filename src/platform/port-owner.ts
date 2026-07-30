import { spawnSync } from "node:child_process";

import { IS_WINDOWS, run } from "../util/proc";
import type { ContainerEngine } from "./engine";
import { isPortAvailable } from "./ports";

/**
 * Answering "who holds this port" rather than silently choosing another one.
 *
 * Scoped infrastructure ports are stable on purpose: generated environments
 * and GUI clients assume they do not drift between starts. When one is taken,
 * the useful response is to name the holder.
 */
export type PortOwner =
  | { kind: "free" }
  | { kind: "our-stack"; stackId: string; container: string }
  | { kind: "other-compose"; project: string; container: string }
  | { kind: "foreign"; pid: number | null; name: string | null }
  | { kind: "unknown" };

interface ContainerPortRow {
  names: string;
  ports: string;
  project: string;
}

async function containerPortRows(
  engine: ContainerEngine,
): Promise<ContainerPortRow[]> {
  const result = await run(
    engine.cli,
    [
      "ps",
      "--format",
      '{{.Names}}\t{{.Ports}}\t{{.Label "com.docker.compose.project"}}',
    ],
    { quiet: true, timeoutMs: 30_000 },
  ).catch(() => null);

  if (!result || result.code !== 0) return [];

  return result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [names = "", ports = "", project = ""] = line.split("\t");
      return { names, ports, project };
    });
}

function rowPublishesPort(row: ContainerPortRow, port: number): boolean {
  // Port strings look like "127.0.0.1:5432->5432/tcp, 1110/tcp" and may use a
  // published range such as "127.0.0.1:9000-9001->9000-9001/tcp".
  for (const mapping of row.ports.split(",")) {
    const match = /:(\d+)(?:-(\d+))?->/.exec(mapping.trim());
    if (!match) continue;

    const start = Number.parseInt(match[1] ?? "", 10);
    const end = match[2] ? Number.parseInt(match[2], 10) : start;
    if (Number.isFinite(start) && port >= start && port <= end) return true;
  }
  return false;
}

/** Best-effort attribution of a listening port to a host process. */
function foreignHolder(
  port: number,
  protocol: "tcp" | "udp",
): PortOwner {
  if (IS_WINDOWS) {
    const netstat = spawnSync("netstat", ["-ano", "-p", protocol], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
    });
    if (netstat.status !== 0 || !netstat.stdout) return { kind: "unknown" };

    for (const line of netstat.stdout.split(/\r?\n/)) {
      if (protocol === "tcp" && !line.includes("LISTENING")) continue;
      const columns = line.trim().split(/\s+/);
      const local = columns[1] ?? "";
      if (!local.endsWith(`:${port}`)) continue;

      const pid = Number.parseInt(columns[columns.length - 1] ?? "", 10);
      if (!Number.isInteger(pid)) return { kind: "unknown" };

      // tasklist is far cheaper than starting PowerShell just for an image name.
      const tasklist = spawnSync(
        "tasklist",
        ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
        { encoding: "utf8", windowsHide: true, timeout: 15_000 },
      );
      const name =
        /^"([^"]+)"/.exec(tasklist.stdout?.trim() ?? "")?.[1] ?? null;

      return { kind: "foreign", pid, name };
    }

    return { kind: "unknown" };
  }

  const commands: Array<[string, string[]]> =
    protocol === "udp"
      ? [
          ["ss", ["-lunpH", `sport = :${port}`]],
          ["lsof", ["-iUDP:" + port, "-P", "-n"]],
        ]
      : [
          ["ss", ["-ltnpH", `sport = :${port}`]],
          ["lsof", ["-iTCP:" + port, "-sTCP:LISTEN", "-P", "-n"]],
        ];

  for (const [command, args] of commands) {
    const result = spawnSync(command, args, {
      encoding: "utf8",
      timeout: 15_000,
    });
    if (result.status !== 0 || !result.stdout?.trim()) continue;

    const pidMatch = /pid=(\d+)/.exec(result.stdout);
    const nameMatch =
      /users:\(\("([^"]+)"/.exec(result.stdout) ??
      /^(\S+)\s+(\d+)/m.exec(result.stdout.split("\n")[1] ?? "");

    return {
      kind: "foreign",
      pid: pidMatch ? Number.parseInt(pidMatch[1] ?? "", 10) : null,
      name: nameMatch?.[1] ?? null,
    };
  }

  return { kind: "unknown" };
}

export async function whoHolds(
  port: number,
  options: {
    engine: ContainerEngine;
    ourStackIds: string[];
    protocol?: "tcp" | "udp";
  },
): Promise<PortOwner> {
  // Containers first: with a remote engine the port is published on the remote
  // host, so a local bind probe would wrongly report it free.
  const rows = await containerPortRows(options.engine);
  for (const row of rows) {
    if (!rowPublishesPort(row, port)) continue;
    if (options.ourStackIds.includes(row.project)) {
      return { kind: "our-stack", stackId: row.project, container: row.names };
    }
    return {
      kind: "other-compose",
      project: row.project || "(no project)",
      container: row.names,
    };
  }

  const protocol = options.protocol ?? "tcp";
  if (await isPortAvailable(port, protocol)) return { kind: "free" };

  return foreignHolder(port, protocol);
}

export function describePortOwner(port: number, owner: PortOwner): string {
  switch (owner.kind) {
    case "free":
      return `port ${port} is free`;
    case "our-stack":
      return `port ${port} is published by ${owner.container} (${owner.stackId})`;
    case "other-compose":
      return `port ${port} is published by ${owner.container} from compose project "${owner.project}"`;
    case "foreign":
      return `port ${port} is held by ${owner.name ?? "an unknown process"}${
        owner.pid ? ` (pid ${owner.pid})` : ""
      }`;
    default:
      return `port ${port} is in use by something WorkTrellis could not identify`;
  }
}
