import fs from "node:fs";

import { readJsonFile, writeJsonFile } from "../util/fs";
import {
  describeProcesses,
  isProcessAlive,
  killTree,
  listeningProcessIds,
  requestCooperativeTreeShutdown,
  type ProcessDescription,
} from "../util/proc";
import { waitForProcessExit } from "./shutdown";

/**
 * Recovering from WorkTrellis not shutting down cleanly — a force-kill, a
 * closed terminal window, a crash. Those leave `next dev` and watcher children
 * alive, holding ports, and the next run must clear them.
 *
 * The danger is pid reuse: a recorded pid may now belong to something else
 * entirely. So a pid is killed only when we can positively identify it as ours.
 */

export interface RunChild {
  name: string;
  pid: number;
  startedAtMs: number;
  /** Substring the process's command line must contain to be considered ours. */
  cmdMustContain: string;
}

export interface RunRecord {
  supervisorPid: number;
  supervisorStartedAt: number;
  project: string;
  slug: string;
  worktreeRoot: string;
  /** Hostnames registered with a URL provider, to release on cleanup. */
  aliases: string[];
  /** Bounded time a provider wrapper may need for cooperative cleanup. */
  cooperativeShutdownGraceMs?: number;
  children: RunChild[];
}

export function readRunRecord(runFile: string): RunRecord | null {
  return readJsonFile<RunRecord>(runFile);
}

export function writeRunRecord(runFile: string, record: RunRecord): void {
  writeJsonFile(runFile, record);
}

export function clearRunRecord(runFile: string): void {
  fs.rmSync(runFile, { force: true });
}

export interface ReapResult {
  stopped: Array<{ name: string; pid: number; forced: boolean }>;
  /** Still alive because ownership could not be verified or signals failed. */
  blocked: Array<{ name: string; pid: number; reason: string }>;
  aliases: string[];
}

export interface PortReapResult {
  stopped: Array<{ pid: number }>;
  blocked: Array<{ pid: number; reason: string }>;
}

/**
 * Kill leftovers from a previous run of THIS workspace.
 *
 * A recorded pid is killed only when all of the following hold:
 *   1. the pid is alive,
 *   2. its command line contains this worktree's root path, and
 *   3. its start time is not clearly newer than the recorded one.
 *
 * If any check cannot be performed, the record is reported and left alone —
 * a missed orphan is a nuisance, but killing an innocent process is not.
 */
export async function reapOrphans(
  runFile: string,
  options: { clearRecord?: boolean; graceMs?: number } = {},
): Promise<ReapResult> {
  const clearRecord = options.clearRecord ?? true;
  const record = readRunRecord(runFile);
  const result: ReapResult = { stopped: [], blocked: [], aliases: [] };
  if (!record) return result;
  const graceMs =
    options.graceMs ?? record.cooperativeShutdownGraceMs ?? 3_000;

  result.aliases = record.aliases ?? [];

  const alive = (record.children ?? []).filter((child) => isProcessAlive(child.pid));
  if (alive.length === 0) {
    if (clearRecord) clearRunRecord(runFile);
    return result;
  }

  const described = describeProcesses(alive.map((child) => child.pid));

  const verified: RunChild[] = [];
  for (const child of alive) {
    const info = described.get(child.pid);

    if (!info) {
      result.blocked.push({
        name: child.name,
        pid: child.pid,
        reason: "could not read the process command line",
      });
      continue;
    }

    const normalized = info.commandLine.replace(/\\/g, "/").toLowerCase();
    const expected = child.cmdMustContain.replace(/\\/g, "/").toLowerCase();

    if (!normalized.includes(expected)) {
      result.blocked.push({
        name: child.name,
        pid: child.pid,
        reason: "the pid now belongs to an unrelated process",
      });
      continue;
    }

    if (info.startedAt !== null && info.startedAt > child.startedAtMs + 60_000) {
      result.blocked.push({
        name: child.name,
        pid: child.pid,
        reason: "the process started well after the recorded run",
      });
      continue;
    }

    verified.push(child);
  }

  // Wrappers such as Portless own route and tunnel cleanup. Give every
  // positively identified orphan the same cooperative shutdown opportunity as
  // a live supervisor before escalating.
  for (const child of verified) {
    requestCooperativeTreeShutdown(child.pid);
  }

  const graceful = await Promise.all(
    verified.map((child) =>
      waitForProcessExit(child.pid, {
        timeoutMs: graceMs,
        pollMs: 50,
      }),
    ),
  );

  for (const [index, child] of verified.entries()) {
    if (graceful[index]) {
      result.stopped.push({ name: child.name, pid: child.pid, forced: false });
      continue;
    }

    killTree(child.pid, "SIGKILL");
    const forced = await waitForProcessExit(child.pid, {
      timeoutMs: 2_000,
      pollMs: 50,
    });
    if (forced) {
      result.stopped.push({ name: child.name, pid: child.pid, forced: true });
    } else {
      result.blocked.push({
        name: child.name,
        pid: child.pid,
        reason: "did not exit after graceful and forced shutdown",
      });
    }
  }

  if (clearRecord && result.blocked.length === 0) clearRunRecord(runFile);
  return result;
}

/**
 * Recover an app tree after its recorded wrapper has already disappeared.
 *
 * The listening PID alone is not enough: it may be a restartable server child
 * whose live parent will immediately replace it. Walk upward through live,
 * worktree-owned ancestors and terminate the highest verified root. When the
 * run record is gone, callers must explicitly opt into the command-line-only
 * ownership proof (the `down --force` recovery path).
 */
export async function reapApplicationPort(
  port: number,
  worktreeRoot: string,
  options: {
    record?: RunRecord | null;
    allowUnrecorded?: boolean;
  } = {},
): Promise<PortReapResult> {
  const result: PortReapResult = { stopped: [], blocked: [] };
  const listeners = [...new Set(listeningProcessIds(port))].filter((pid) =>
    isProcessAlive(pid),
  );
  if (listeners.length === 0) return result;

  if (!options.record && options.allowUnrecorded !== true) {
    for (const pid of listeners) {
      result.blocked.push({
        pid,
        reason:
          "run state is missing; rerun `worktrellis down --force` to verify the port owner by its worktree path",
      });
    }
    return result;
  }

  const described = describeWithLiveAncestors(listeners);
  const expected = worktreeRoot.replace(/\\/g, "/").toLowerCase();
  const earliestRecordedStart = options.record?.children
    .map((child) => child.startedAtMs)
    .filter(Number.isFinite)
    .reduce<number | undefined>(
      (earliest, value) =>
        earliest === undefined ? value : Math.min(earliest, value),
      undefined,
    );

  const roots = new Map<
    number,
    { root: ProcessDescription; listeners: number[] }
  >();
  for (const listenerPid of listeners) {
    const listener = described.get(listenerPid);
    if (
      !listener ||
      !belongsToWorktree(listener, expected, earliestRecordedStart)
    ) {
      result.blocked.push({
        pid: listenerPid,
        reason: "the listening process could not be verified as belonging to this worktree",
      });
      continue;
    }

    let root = listener;
    const visited = new Set<number>([listener.pid]);
    while (root.parentPid && !visited.has(root.parentPid)) {
      const parent = described.get(root.parentPid);
      if (!parent || !belongsToWorktree(parent, expected, earliestRecordedStart)) {
        break;
      }
      visited.add(parent.pid);
      root = parent;
    }

    const existing = roots.get(root.pid);
    if (existing) {
      existing.listeners.push(listenerPid);
    } else {
      roots.set(root.pid, { root, listeners: [listenerPid] });
    }
  }

  for (const { root, listeners: ownedListeners } of roots.values()) {
    const attempted = killTree(root.pid, "SIGKILL");
    await waitForProcessExit(root.pid, { timeoutMs: 2_000, pollMs: 50 });
    const survivors = ownedListeners.filter((pid) => isProcessAlive(pid));
    if (survivors.length === 0) {
      result.stopped.push({ pid: root.pid });
    } else {
      for (const pid of survivors) {
        result.blocked.push({
          pid,
          reason: attempted
            ? "the verified process tree did not exit after forced shutdown"
            : "the operating-system tree kill failed",
        });
      }
    }
  }

  return result;
}

function belongsToWorktree(
  processInfo: ProcessDescription,
  expectedRoot: string,
  earliestRecordedStart: number | undefined,
): boolean {
  const command = processInfo.commandLine.replace(/\\/g, "/").toLowerCase();
  if (!command.includes(expectedRoot)) return false;
  if (
    earliestRecordedStart !== undefined &&
    processInfo.startedAt !== null &&
    processInfo.startedAt < earliestRecordedStart - 10_000
  ) {
    return false;
  }
  return true;
}

function describeWithLiveAncestors(
  pids: number[],
): Map<number, ProcessDescription> {
  const described = new Map<number, ProcessDescription>();
  const requested = new Set<number>();
  let frontier = [...new Set(pids)];

  for (let depth = 0; depth < 32 && frontier.length > 0; depth += 1) {
    for (const pid of frontier) requested.add(pid);
    const batch = describeProcesses(frontier);
    for (const [pid, processInfo] of batch) described.set(pid, processInfo);
    frontier = [
      ...new Set(
        [...batch.values()]
          .map((processInfo) => processInfo.parentPid)
          .filter(
            (pid): pid is number =>
              pid !== null && pid > 0 && !requested.has(pid),
          ),
      ),
    ];
  }

  return described;
}
