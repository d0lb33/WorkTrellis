import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { WorkspaceIdentity } from "../types";
import { ensureDirectory, readJsonFile, writeJsonFile } from "../util/fs";

/**
 * Two state locations, with a deliberate split:
 *
 *   machine-global (~/.worktrellis) — shared infrastructure, cross-project
 *                                     index, locks, per-machine port overrides.
 *   per-worktree   (<root>/.worktrellis) — this workspace's generated env,
 *                                         pinned identity, live pids, and logs.
 *
 */

export function worktrellisHome(): string {
  const override = process.env.WORKTRELLIS_HOME?.trim();
  if (override) return path.resolve(override);
  return path.join(os.homedir(), ".worktrellis");
}

export const homePaths = {
  root: worktrellisHome,
  machineConfig: () => path.join(worktrellisHome(), "machine.json"),
  stacks: () => path.join(worktrellisHome(), "stacks"),
  stack: (stackId: string) => path.join(worktrellisHome(), "stacks", stackId),
  locks: () => path.join(worktrellisHome(), "locks"),
  lock: (name: string) => path.join(worktrellisHome(), "locks", `${name}.lock`),
  workspaces: () => path.join(worktrellisHome(), "workspaces"),
  workspaceIndex: (repoKey: string, slug: string) =>
    path.join(worktrellisHome(), "workspaces", repoKey, `${slug}.json`),
};

export const WORKTRELLIS_DIRNAME = ".worktrellis";

function workspaceStateRoot(worktreeRoot: string): string {
  return path.join(worktreeRoot, WORKTRELLIS_DIRNAME);
}

export function workspacePaths(worktreeRoot: string, workspaceKey?: string) {
  const base = workspaceStateRoot(worktreeRoot);

  // Logs live OUTSIDE the worktree on purpose. Dev servers and file watchers
  // watch the project directory, and a log file being appended to inside it is
  // a reliable way to trigger an endless rebuild loop.
  const logs = path.join(
    worktrellisHome(),
    "logs",
    workspaceKey ?? path.basename(worktreeRoot),
  );

  return {
    root: base,
    env: path.join(base, "env"),
    workspace: path.join(base, "workspace.json"),
    state: path.join(base, "state.json"),
    run: path.join(base, "run.json"),
    logs,
    log: (name: string) => path.join(logs, `${name}.log`),
  };
}

// ---------------------------------------------------------------------------
// Live run state
// ---------------------------------------------------------------------------

/**
 * What the currently running `up` claimed: the URL it registered and the port
 * it bound. Read-only commands reuse this instead of deriving their own, so
 * they never re-register a hostname or pick a competing port.
 */
export interface LiveRunState {
  pid: number;
  startedAt: string;
  url: {
    mode: "portless" | "direct";
    appUrl: string;
    rootDomain: string;
    cookieDomain: string;
    tenantUrlTemplate: string;
    wildcardOrigins: string[];
    listenHost: string;
    listenPort: number;
    providerEnv: Record<string, string>;
  };
}

export function readLiveRunState(stateFile: string): LiveRunState | null {
  return readJsonFile<LiveRunState>(stateFile);
}

export function writeLiveRunState(stateFile: string, state: LiveRunState): void {
  writeJsonFile(stateFile, state);
}

export function clearLiveRunState(stateFile: string): void {
  fs.rmSync(stateFile, { force: true });
}

// ---------------------------------------------------------------------------
// Machine configuration
// ---------------------------------------------------------------------------

export interface MachineConfig {
  /** Per-machine overrides by named port, e.g. { database: 5433 }. */
  portOverrides?: Record<string, number>;
  /** Preferred container engine, when both are installed. */
  engine?: "docker" | "podman";
}

export function readMachineConfig(): MachineConfig {
  return readJsonFile<MachineConfig>(homePaths.machineConfig()) ?? {};
}

export function writeMachineConfig(config: MachineConfig): void {
  ensureDirectory(worktrellisHome());
  writeJsonFile(homePaths.machineConfig(), config);
}

// ---------------------------------------------------------------------------
// Cross-project workspace index
// ---------------------------------------------------------------------------

export interface WorkspaceRecord {
  project: string;
  slug: string;
  repoKey: string;
  worktreeRoot: string;
  branch: string | null;
  hostname: string;
  appUrl: string;
  lastSeenAt: string;
  createdAt: string;
}

/**
 * Record this workspace in the machine-wide index. This is what lets
 * `worktrellis list` show every worktree of every project, and what gives the
 * garbage collector something to reconcile against.
 */
export function touchWorkspaceRecord(
  identity: WorkspaceIdentity,
  extra: { hostname: string; appUrl: string },
): void {
  const file = homePaths.workspaceIndex(identity.repoKey, identity.slug);
  const existing = readJsonFile<WorkspaceRecord>(file);
  const now = new Date().toISOString();

  ensureDirectory(path.dirname(file));
  writeJsonFile(file, {
    project: identity.project,
    slug: identity.slug,
    repoKey: identity.repoKey,
    worktreeRoot: identity.root,
    branch: identity.branch,
    hostname: extra.hostname,
    appUrl: extra.appUrl,
    createdAt: existing?.createdAt ?? now,
    lastSeenAt: now,
  } satisfies WorkspaceRecord);
}

export function readWorkspaceRecords(options: { project?: string } = {}): WorkspaceRecord[] {
  const base = homePaths.workspaces();
  if (!fs.existsSync(base)) return [];

  const records: WorkspaceRecord[] = [];

  for (const repoKey of fs.readdirSync(base)) {
    const directory = path.join(base, repoKey);
    let entries: string[];
    try {
      entries = fs.readdirSync(directory);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const record = readJsonFile<WorkspaceRecord>(path.join(directory, entry));
      if (!record) continue;
      if (options.project && record.project !== options.project) continue;
      records.push(record);
    }
  }

  return records.sort(
    (a, b) =>
      a.project.localeCompare(b.project) || a.slug.localeCompare(b.slug),
  );
}

export function removeWorkspaceRecord(repoKey: string, slug: string): void {
  fs.rmSync(homePaths.workspaceIndex(repoKey, slug), { force: true });
}
