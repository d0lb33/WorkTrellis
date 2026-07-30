import fs from "node:fs";

import { readJsonFile, writeJsonFile } from "../util/fs";
import { describeProcesses, isProcessAlive, killTree } from "../util/proc";

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
  killed: Array<{ name: string; pid: number }>;
  /** Alive, but could not be confirmed as ours — reported, never killed. */
  unverified: Array<{ name: string; pid: number; reason: string }>;
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
export function reapOrphans(runFile: string): ReapResult {
  const record = readRunRecord(runFile);
  const result: ReapResult = { killed: [], unverified: [], aliases: [] };
  if (!record) return result;

  result.aliases = record.aliases ?? [];

  const alive = (record.children ?? []).filter((child) => isProcessAlive(child.pid));
  if (alive.length === 0) {
    clearRunRecord(runFile);
    return result;
  }

  const described = describeProcesses(alive.map((child) => child.pid));

  for (const child of alive) {
    const info = described.get(child.pid);

    if (!info) {
      result.unverified.push({
        name: child.name,
        pid: child.pid,
        reason: "could not read the process command line",
      });
      continue;
    }

    const normalized = info.commandLine.replace(/\\/g, "/").toLowerCase();
    const expected = child.cmdMustContain.replace(/\\/g, "/").toLowerCase();

    if (!normalized.includes(expected)) {
      result.unverified.push({
        name: child.name,
        pid: child.pid,
        reason: "the pid now belongs to an unrelated process",
      });
      continue;
    }

    if (info.startedAt !== null && info.startedAt > child.startedAtMs + 60_000) {
      result.unverified.push({
        name: child.name,
        pid: child.pid,
        reason: "the process started well after the recorded run",
      });
      continue;
    }

    killTree(child.pid, "SIGKILL");
    result.killed.push({ name: child.name, pid: child.pid });
  }

  clearRunRecord(runFile);
  return result;
}
