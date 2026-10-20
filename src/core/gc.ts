import fs from "node:fs";
import path from "node:path";

import type { WorkspaceIdentity, WorkTrellisConfig } from "../types";
import { usageError } from "./errors";
import { FINGERPRINT_LENGTH } from "./naming";
import type { WorkspaceRecord } from "./state";

/**
 * Which recorded workspaces `worktrellis prune` may clean up. Selection is
 * pure so that `doctor` can report it without touching anything.
 */

export type WorktreeAvailability = "present" | "missing" | "unavailable";

/** Directories whose children are volumes rather than ordinary folders. */
const MOUNT_ROOTS = new Set(["/volumes", "/mnt", "/media", "/run/media"]);

/**
 * A missing worktree counts as deleted when some ancestor directory still
 * exists. Worktree tools often remove a per-worktree parent too (for example
 * `<tool>/worktrees/<id>/<repo>`), so the nearest surviving ancestor is what
 * matters. When that ancestor is a filesystem root, a drive root, or a mount
 * root such as `/Volumes`, the volume itself is gone: the worktree is
 * unavailable, so a disconnected drive never makes its worktrees prunable.
 */
export function worktreeAvailability(root: string): WorktreeAvailability {
  if (fs.existsSync(root)) return "present";
  let ancestor = path.dirname(path.resolve(root));
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) return "unavailable";
    ancestor = parent;
  }
  const normalized = ancestor.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const isFilesystemRoot = path.dirname(ancestor) === ancestor;
  const isMountRoot =
    MOUNT_ROOTS.has(normalized) || /^\/run\/media\/[^/]+$/.test(normalized);
  return isFilesystemRoot || isMountRoot ? "unavailable" : "missing";
}

export type LeaseState = "live" | "stale" | "unverified" | "none";

export interface PruneCandidate {
  record: WorkspaceRecord;
  reason: "missing" | "idle";
  /** Whole days since the record was last refreshed, for idle candidates. */
  idleDays?: number;
}

export interface PruneSkip {
  record: WorkspaceRecord;
  reason: string;
}

export interface PruneSelection {
  candidates: PruneCandidate[];
  skipped: PruneSkip[];
}

const DAY_MS = 86_400_000;

export function selectPruneCandidates(options: {
  records: WorkspaceRecord[];
  project: string;
  /** The worktree running the command is never selected. */
  current: { repoKey: string; slug: string };
  maxIdleDays?: number;
  now: number;
  leaseState: (record: WorkspaceRecord) => LeaseState;
  availability?: (root: string) => WorktreeAvailability;
}): PruneSelection {
  const availability = options.availability ?? worktreeAvailability;
  const candidates: PruneCandidate[] = [];
  const skipped: PruneSkip[] = [];

  for (const record of options.records) {
    if (record.project !== options.project) continue;
    if (
      record.repoKey === options.current.repoKey &&
      record.slug === options.current.slug
    ) {
      continue;
    }

    const location = availability(record.worktreeRoot);
    if (location === "unavailable") {
      skipped.push({
        record,
        reason:
          "its volume is not mounted, so deletion cannot be confirmed",
      });
      continue;
    }

    let candidate: PruneCandidate | null = null;
    if (location === "missing") {
      candidate = { record, reason: "missing" };
    } else if (options.maxIdleDays !== undefined) {
      const lastSeen = Date.parse(record.lastSeenAt);
      const idleDays = Number.isFinite(lastSeen)
        ? Math.floor((options.now - lastSeen) / DAY_MS)
        : null;
      if (idleDays !== null && idleDays >= options.maxIdleDays) {
        candidate = { record, reason: "idle", idleDays };
      }
    }
    if (!candidate) continue;

    const lease = options.leaseState(record);
    if (lease === "live" || lease === "unverified") {
      skipped.push({
        record,
        reason:
          lease === "live"
            ? "a WorkTrellis supervisor is still running for it"
            : "its recorded supervisor could not be verified as stopped",
      });
      continue;
    }
    candidates.push(candidate);
  }

  return { candidates, skipped };
}

/**
 * Rebuild the identity a removed worktree had, from its record. Every derived
 * resource name depends only on the project and slug, both of which are kept.
 */
export function identityFromRecord(record: WorkspaceRecord): WorkspaceIdentity {
  return {
    root: record.worktreeRoot,
    repoKey: record.repoKey,
    // Unknowable once the worktree is gone; no derived name depends on it.
    isLinkedWorktree: false,
    branch: record.branch,
    head: "unknown",
    project: record.project,
    slug: record.slug,
    fingerprint: record.slug.slice(-FINGERPRINT_LENGTH),
    ports: {},
  };
}

/** `--max-idle-days` overrides `gc.maxIdleDays`; neither means deleted only. */
export function resolveMaxIdleDays(
  flag: string | undefined,
  config: Pick<WorkTrellisConfig, "gc">,
): number | undefined {
  if (flag === undefined) return config.gc?.maxIdleDays;
  const days = Number(flag);
  if (!/^\d+$/.test(flag.trim()) || !Number.isInteger(days) || days < 1) {
    usageError("`--max-idle-days` must be a positive whole number of days.");
  }
  return days;
}
