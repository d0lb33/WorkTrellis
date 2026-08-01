import fs from "node:fs";
import path from "node:path";

import { homePaths } from "../core/state";
import { ensureDirectory, readJsonFile, writeJsonFile } from "../util/fs";
import { describeProcesses, isProcessAlive } from "../util/proc";

export const LINEAGE_STATE_VERSION = 1 as const;

export interface LineageSelection {
  compatibilityId: string;
  projectName: string;
  ports: Record<string, number>;
  selectedAt: string;
}

export interface LineageRegistry {
  version: typeof LINEAGE_STATE_VERSION;
  selections: Record<string, LineageSelection>;
}

export interface LineageManifest {
  version: typeof LINEAGE_STATE_VERSION;
  stackName: string;
  scope: "machine";
  compatibilityId: string;
  projectName: string;
  definitionHash: string;
  volumeDataVersions: Record<string, string>;
  updatedAt: string;
}

export interface StackLeaseBinding {
  name: string;
  compatibilityId: string;
  projectName: string;
}

export interface MachineRunLease {
  version: typeof LINEAGE_STATE_VERSION;
  pid: number;
  startedAtMs: number;
  project: string;
  repoKey: string;
  slug: string;
  branch: string | null;
  worktreeRoot: string;
  stacks: StackLeaseBinding[];
}

export interface LeaseConsumer {
  project: string;
  repoKey: string;
  slug: string;
  branch: string | null;
  pid: number;
  worktreeExists: boolean;
  state: "live" | "stale" | "unverified";
  reason?: string;
}

export function readLineageRegistry(): LineageRegistry {
  const value = readJsonFile<LineageRegistry>(homePaths.lineageRegistry());
  if (value?.version === LINEAGE_STATE_VERSION && value.selections) return value;
  return { version: LINEAGE_STATE_VERSION, selections: {} };
}

export function selectedLineage(
  compatibilityId: string,
): LineageSelection | null {
  return readLineageRegistry().selections[compatibilityId] ?? null;
}

export function writeLineageSelection(selection: LineageSelection): void {
  const registry = readLineageRegistry();
  registry.selections[selection.compatibilityId] = selection;
  writeJsonFile(homePaths.lineageRegistry(), registry);
}

export function replaceProjectLineageSelection(
  selection: LineageSelection,
): void {
  const registry = readLineageRegistry();
  for (const [compatibilityId, existing] of Object.entries(
    registry.selections,
  )) {
    if (
      existing.projectName === selection.projectName &&
      compatibilityId !== selection.compatibilityId
    ) {
      delete registry.selections[compatibilityId];
    }
  }
  registry.selections[selection.compatibilityId] = selection;
  writeJsonFile(homePaths.lineageRegistry(), registry);
}

export function projectSelection(
  projectName: string,
): LineageSelection | null {
  return (
    Object.values(readLineageRegistry().selections).find(
      (selection) => selection.projectName === projectName,
    ) ?? null
  );
}

export function removeLineageSelection(compatibilityId: string): void {
  const registry = readLineageRegistry();
  if (!registry.selections[compatibilityId]) return;
  delete registry.selections[compatibilityId];
  writeJsonFile(homePaths.lineageRegistry(), registry);
}

export function lineageManifestPath(projectName: string): string {
  return path.join(homePaths.stack(projectName), "lineage.json");
}

export function readLineageManifest(
  projectName: string,
): LineageManifest | null {
  const value = readJsonFile<LineageManifest>(lineageManifestPath(projectName));
  return value?.version === LINEAGE_STATE_VERSION ? value : null;
}

export function writeLineageManifest(manifest: LineageManifest): void {
  writeJsonFile(lineageManifestPath(manifest.projectName), manifest);
}

export function writeMachineRunLease(lease: MachineRunLease): void {
  ensureDirectory(homePaths.runLeases());
  writeJsonFile(homePaths.runLease(lease.repoKey, lease.slug), lease);
}

export function clearMachineRunLease(repoKey: string, slug: string): void {
  fs.rmSync(homePaths.runLease(repoKey, slug), { force: true });
}

export function readMachineRunLeases(): MachineRunLease[] {
  const directory = homePaths.runLeases();
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) =>
      readJsonFile<MachineRunLease>(path.join(directory, entry)),
    )
    .filter(
      (lease): lease is MachineRunLease =>
        lease?.version === LINEAGE_STATE_VERSION,
    );
}

export function consumersForProject(projectName: string): LeaseConsumer[] {
  return readMachineRunLeases()
    .filter((lease) =>
      lease.stacks.some((stack) => stack.projectName === projectName),
    )
    .map((lease) => classifyLease(lease));
}

export function clearVerifiedStaleLeases(projectName: string): void {
  for (const lease of readMachineRunLeases()) {
    if (!lease.stacks.some((stack) => stack.projectName === projectName)) continue;
    if (classifyLease(lease).state === "stale") {
      clearMachineRunLease(lease.repoKey, lease.slug);
    }
  }
}

function classifyLease(lease: MachineRunLease): LeaseConsumer {
  const base = {
    project: lease.project,
    repoKey: lease.repoKey,
    slug: lease.slug,
    branch: lease.branch,
    pid: lease.pid,
    worktreeExists: fs.existsSync(lease.worktreeRoot),
  };
  if (!isProcessAlive(lease.pid)) return { ...base, state: "stale" };

  if (!base.worktreeExists) {
    return {
      ...base,
      state: "unverified",
      reason: "the recorded worktree is missing; clean up its process manually",
    };
  }

  const processInfo = describeProcesses([lease.pid]).get(lease.pid);
  if (!processInfo) {
    return {
      ...base,
      state: "unverified",
      reason: "could not inspect the supervisor process",
    };
  }
  const command = processInfo.commandLine.replace(/\\/g, "/").toLowerCase();
  const expected = lease.worktreeRoot.replace(/\\/g, "/").toLowerCase();
  if (!command.includes(expected)) {
    return {
      ...base,
      state: "stale",
      reason: "the pid now belongs to another process",
    };
  }
  if (processInfo.startedAt === null) {
    return {
      ...base,
      state: "unverified",
      reason: "could not verify the supervisor start time",
    };
  }
  if (Math.abs(processInfo.startedAt - lease.startedAtMs) > 60_000) {
    return {
      ...base,
      state: "stale",
      reason: "the pid was reused by a newer process",
    };
  }
  return { ...base, state: "live" };
}
