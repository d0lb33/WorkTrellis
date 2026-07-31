import fs from "node:fs";

import { normalizePath, readJsonFile, writeJsonFile } from "../util/fs";
import {
  describeProcesses,
  isProcessAlive,
} from "../util/proc";
import type { RunRecord } from "./reaper";

export interface ShutdownRequest {
  supervisorPid: number;
  supervisorStartedAt: number;
  requestedAt: string;
}

export interface SupervisorVerification {
  verified: boolean;
  reason?: string;
}

const START_TIME_TOLERANCE_MS = 10_000;

export function clearShutdownRequest(file: string): void {
  fs.rmSync(file, { force: true });
}

export function requestGracefulShutdown(
  file: string,
  target: Pick<RunRecord, "supervisorPid" | "supervisorStartedAt">,
): void {
  writeJsonFile(file, {
    supervisorPid: target.supervisorPid,
    supervisorStartedAt: target.supervisorStartedAt,
    requestedAt: new Date().toISOString(),
  } satisfies ShutdownRequest);
}

/**
 * Consume only a request addressed to this exact supervisor incarnation.
 * Mismatched requests are stale and cannot be allowed to stop a later run that
 * happens to reuse the same PID.
 */
export function consumeShutdownRequest(
  file: string,
  target: Pick<RunRecord, "supervisorPid" | "supervisorStartedAt">,
): boolean {
  const request = readJsonFile<ShutdownRequest>(file);
  if (!request) return false;

  clearShutdownRequest(file);
  return (
    request.supervisorPid === target.supervisorPid &&
    request.supervisorStartedAt === target.supervisorStartedAt
  );
}

/**
 * Confirm a persisted supervisor PID still identifies this workspace's run
 * before a separate `worktrellis down` process signals or force-kills it.
 */
export function verifySupervisorForShutdown(
  record: RunRecord | null,
  expected: {
    pid: number;
    startedAt?: string;
    project: string;
    slug: string;
    worktreeRoot: string;
  },
): SupervisorVerification {
  if (!record) {
    return { verified: false, reason: "the run record is missing" };
  }
  if (record.supervisorPid !== expected.pid) {
    return {
      verified: false,
      reason: "the live state and run record name different supervisor PIDs",
    };
  }
  if (
    record.project !== expected.project ||
    record.slug !== expected.slug ||
    normalizePath(record.worktreeRoot) !== normalizePath(expected.worktreeRoot)
  ) {
    return {
      verified: false,
      reason: "the run record belongs to another workspace",
    };
  }

  if (expected.startedAt) {
    const liveStartedAt = Date.parse(expected.startedAt);
    if (
      !Number.isFinite(liveStartedAt) ||
      Math.abs(liveStartedAt - record.supervisorStartedAt) >
        START_TIME_TOLERANCE_MS
    ) {
      return {
        verified: false,
        reason: "the live state and run record have different start times",
      };
    }
  }

  if (!isProcessAlive(expected.pid)) {
    return { verified: false, reason: "the recorded supervisor is not running" };
  }

  const processInfo = describeProcesses([expected.pid]).get(expected.pid);
  if (!processInfo) {
    return {
      verified: false,
      reason: "the supervisor process could not be inspected",
    };
  }
  if (
    processInfo.startedAt === null ||
    Math.abs(processInfo.startedAt - record.supervisorStartedAt) >
      START_TIME_TOLERANCE_MS
  ) {
    return {
      verified: false,
      reason: "the supervisor PID has been reused by another process",
    };
  }

  return { verified: true };
}

export async function waitForProcessExit(
  pid: number,
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 8_000;
  const pollMs = options.pollMs ?? 100;
  const deadline = Date.now() + timeoutMs;

  while (isProcessAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  return !isProcessAlive(pid);
}
