import fs from "node:fs";

import { readJsonFile, writeJsonFile } from "../util/fs";
import {
  describeProcesses,
  isProcessAlive,
  killTree,
  requestCooperativeTreeShutdown,
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
