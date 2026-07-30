import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { conflictError } from "./errors";
import { homePaths } from "./state";
import { ensureDirectory, readJsonFile } from "../util/fs";
import { describeProcesses, isProcessAlive } from "../util/proc";

/**
 * A cross-process lock built on `mkdir`, which is atomic on every platform
 * WorkTrellis targets — including Windows and network filesystems, where the
 * exclusive-open flags behave inconsistently.
 *
 * Used to serialize two worktrees racing to start the same shared service.
 */

export interface LockOwner {
  pid: number;
  hostname: string;
  startedAt: number;
  /** Something the owning process's command line must contain. */
  signature: string;
}

export interface LockHandle {
  release(): void;
}

export interface AcquireOptions {
  timeoutMs?: number;
  /** Called periodically while blocked, so the user learns why they are waiting. */
  onWait?: (owner: LockOwner | null, elapsedMs: number) => void;
}

const OWNER_FILE = "owner.json";
const POLL_INTERVAL_MS = 150;
const WAIT_NOTICE_AFTER_MS = 3_000;

function writeOwner(lockDirectory: string): void {
  const owner: LockOwner = {
    pid: process.pid,
    hostname: os.hostname(),
    startedAt: Date.now(),
    signature: process.argv.slice(0, 2).join(" "),
  };
  fs.writeFileSync(
    path.join(lockDirectory, OWNER_FILE),
    `${JSON.stringify(owner, null, 2)}\n`,
  );
}

function readOwner(lockDirectory: string): LockOwner | null {
  return readJsonFile<LockOwner>(path.join(lockDirectory, OWNER_FILE));
}

/**
 * A lock is stale only when we can positively establish its owner is gone.
 *
 * "The pid is alive" is not enough to keep it, and not enough to break it
 * either: pids are recycled, so an unrelated process can inherit the recorded
 * pid. We break the lock when the pid is dead, or when the live process's start
 * time clearly postdates the lock (proving it is a different process).
 */
function isStale(owner: LockOwner | null): boolean {
  if (!owner) return true;
  if (owner.hostname !== os.hostname()) return false;
  if (!isProcessAlive(owner.pid)) return true;

  const described = describeProcesses([owner.pid]).get(owner.pid);
  if (!described?.startedAt) return false;

  // Allow a second of slack for clock granularity between the two sources.
  return described.startedAt > owner.startedAt + 1_000;
}

export async function acquireLock(
  name: string,
  options: AcquireOptions = {},
): Promise<LockHandle> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const lockDirectory = homePaths.lock(name);
  ensureDirectory(homePaths.locks());

  const deadline = Date.now() + timeoutMs;
  const startedAt = Date.now();
  let noticed = false;

  for (;;) {
    try {
      fs.mkdirSync(lockDirectory);
      writeOwner(lockDirectory);
      return {
        release() {
          try {
            fs.rmSync(lockDirectory, { recursive: true, force: true });
          } catch {
            // Releasing is best effort; a stale directory is recoverable.
          }
        },
      };
    } catch (caught) {
      if ((caught as NodeJS.ErrnoException).code !== "EEXIST") throw caught;
    }

    const owner = readOwner(lockDirectory);

    if (isStale(owner)) {
      fs.rmSync(lockDirectory, { recursive: true, force: true });
      continue;
    }

    const elapsed = Date.now() - startedAt;
    if (!noticed && elapsed > WAIT_NOTICE_AFTER_MS) {
      noticed = true;
      options.onWait?.(owner, elapsed);
    }

    if (Date.now() >= deadline) {
      conflictError(
        `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the "${name}" lock.`,
        owner
          ? `Held by pid ${owner.pid} on ${owner.hostname} since ${new Date(owner.startedAt).toLocaleTimeString()}.\nIf that process is gone, remove ${lockDirectory}`
          : `Remove ${lockDirectory} if no other WorkTrellis process is running.`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

/** Run `work` while holding `name`, releasing it even if `work` throws. */
export async function withLock<T>(
  name: string,
  work: () => Promise<T>,
  options: AcquireOptions = {},
): Promise<T> {
  const handle = await acquireLock(name, options);
  try {
    return await work();
  } finally {
    handle.release();
  }
}
