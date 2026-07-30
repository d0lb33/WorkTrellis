import path from "node:path";

import type { WorkspaceIdentity } from "../types";
import { environmentError } from "./errors";
import {
  assertProjectName,
  buildBucketName,
  buildDatabaseName,
  buildRedisPrefix,
  buildSlug,
  FINGERPRINT_LENGTH,
  sanitizeLabel,
} from "./naming";
import { normalizePath, readJsonFile, writeJsonFile } from "../util/fs";
import { hexModulo, sha1, sha256 } from "../util/hash";
import { run, whichSync } from "../util/proc";

/** Branch names that carry no useful worktree meaning. */
const UNINFORMATIVE_BRANCHES = new Set(["main", "master", "head"]);

/** Redis ships 16 logical databases by default. */
const REDIS_DATABASE_COUNT = 16;

export interface GitFacts {
  toplevel: string;
  gitDir: string;
  gitCommonDir: string;
  branch: string | null;
  head: string;
}

export async function probeGit(cwd: string): Promise<GitFacts> {
  const git = whichSync("git");
  if (!git) {
    environmentError(
      "git was not found on PATH.",
      "WorkTrellis derives each worktree's identity from git. Install git and try again.",
    );
  }

  const result = await run(
    git,
    [
      "rev-parse",
      "--path-format=absolute",
      "--show-toplevel",
      "--git-dir",
      "--git-common-dir",
    ],
    { cwd, capture: true },
  );

  if (result.code !== 0) {
    environmentError(
      `Not inside a git repository (${cwd}).`,
      "WorkTrellis identifies a workspace by its git worktree. Run this from inside the repository.",
    );
  }

  const [toplevel, gitDir, gitCommonDir] = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!toplevel || !gitDir || !gitCommonDir) {
    environmentError(`Could not read git paths for ${cwd}.`);
  }

  const branchResult = await run(git, ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd,
    capture: true,
  });
  const rawBranch = branchResult.stdout.trim();
  const branch = rawBranch === "" || rawBranch === "HEAD" ? null : rawBranch;

  const headResult = await run(git, ["rev-parse", "--short", "HEAD"], {
    cwd,
    capture: true,
  });

  return {
    toplevel,
    gitDir,
    gitCommonDir,
    branch,
    head: headResult.stdout.trim() || "unknown",
  };
}

/**
 * The human-readable half of a slug. A branch's last path segment is the most
 * recognizable thing available; `main`, `master`, and detached HEAD carry no
 * distinguishing information, so those fall back to the directory name.
 */
export function labelFor(facts: GitFacts): string {
  const candidates: string[] = [];

  if (facts.branch) {
    const lastSegment = facts.branch.split("/").pop() ?? facts.branch;
    if (!UNINFORMATIVE_BRANCHES.has(lastSegment.toLowerCase())) {
      candidates.push(lastSegment);
    }
  }

  candidates.push(path.basename(facts.toplevel));
  if (facts.branch) candidates.push(facts.branch);

  for (const candidate of candidates) {
    const label = sanitizeLabel(candidate);
    if (label.length > 0) return label;
  }

  return "workspace";
}

export interface PinnedIdentity {
  slug: string;
  fingerprint: string;
  label: string;
  project: string;
  pinnedAt: string;
  worktreeRoot: string;
}

/**
 * Resolve this worktree's identity.
 *
 * The fingerprint is derived from the worktree PATH, not the branch. That is
 * what makes it collision-proof: two worktrees whose branches share a last
 * segment (`feat/a/deploy` and `fix/b/deploy`) still differ, and a worktree on
 * `main` is still distinct from a second clone on `main`.
 *
 * The result is pinned to disk on first use so that renaming a branch does not
 * orphan the database and bucket that were already provisioned.
 */
export async function resolveIdentity(options: {
  cwd: string;
  project: string;
  pinFile: string;
  extraPorts?: string[];
  basePort?: number;
}): Promise<WorkspaceIdentity> {
  assertProjectName(options.project);

  const facts = await probeGit(options.cwd);
  const root = normalizePath(facts.toplevel);
  const fingerprint = sha256(root).slice(0, FINGERPRINT_LENGTH);
  const repoKey = sha1(normalizePath(facts.gitCommonDir)).slice(0, 12);

  const pinned = readJsonFile<PinnedIdentity>(options.pinFile);
  const pinValid =
    pinned !== null &&
    pinned.project === options.project &&
    pinned.fingerprint === fingerprint;

  const label = pinValid ? pinned.label : labelFor(facts);
  const slug = pinValid ? pinned.slug : buildSlug(label, fingerprint);

  if (!pinValid) {
    writeJsonFile(options.pinFile, {
      slug,
      fingerprint,
      label,
      project: options.project,
      pinnedAt: new Date().toISOString(),
      worktreeRoot: facts.toplevel,
    } satisfies PinnedIdentity);
  }

  return {
    root: facts.toplevel,
    repoKey,
    // A linked worktree keeps its own .git *file*, so its git dir differs from
    // the repository's common dir. Equal paths mean this is the main checkout.
    isLinkedWorktree: normalizePath(facts.gitDir) !== normalizePath(facts.gitCommonDir),
    branch: facts.branch,
    head: facts.head,
    project: options.project,
    slug,
    fingerprint,
    databaseName: buildDatabaseName(options.project, slug),
    bucketName: buildBucketName(options.project, slug),
    redisPrefix: buildRedisPrefix(options.project, slug),
    redisDb: hexModulo(fingerprint, REDIS_DATABASE_COUNT),
    ports: derivePorts(fingerprint, options.basePort ?? 3000, options.extraPorts ?? []),
  };
}

/**
 * Deterministic ports, so a worktree keeps the same address across restarts and
 * a bookmark stays valid. These are preferences: whoever binds them verifies
 * availability first and records what it actually got.
 */
function derivePorts(
  fingerprint: string,
  basePort: number,
  extra: string[],
): Record<string, number> {
  const names = ["app", ...extra];
  const ports: Record<string, number> = {};

  names.forEach((name, index) => {
    const seed = sha256(`${fingerprint}:${name}`);
    ports[name] = basePort + index * 500 + hexModulo(seed, 400);
  });

  return ports;
}
