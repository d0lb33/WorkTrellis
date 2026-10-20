import fs from "node:fs";

import { WorkTrellisError } from "../core/errors";
import { withLock } from "../core/lock";
import { homePaths } from "../core/state";
import { run } from "../util/proc";
import { isMachineVariantName } from "./compose-render";
import type { ContainerEngine } from "./engine";
import { readComposeInventory, type ComposeInventory } from "./lineage";
import {
  consumersForProject,
  readLineageRegistry,
  removeLineageSelection,
  type LeaseConsumer,
  type LineageRegistry,
} from "./lineage-state";

/**
 * Cleanup of WorkTrellis's own machine state. Retained data is never touched
 * here: a machine variant with containers or volumes keeps its definition, and
 * removing a variant's volumes stays `services down --variant --volumes`.
 */

export interface DefinitionCleanup {
  projectName: string;
  /**
   * remove-selection: a lineage selection points at a variant with nothing
   * left. remove-definition: a definition directory nothing refers to.
   */
  action: "remove-selection" | "remove-definition";
  compatibilityId?: string;
}

export function composeProjectIsEmpty(
  inventory: ComposeInventory,
  projectName: string,
): boolean {
  return (
    (inventory.containers.get(projectName)?.total ?? 0) === 0 &&
    (inventory.volumes.get(projectName)?.size ?? 0) === 0
  );
}

/** Plan which machine definitions of `stackNames` are safe to forget. */
export function planMachineDefinitionCleanup(options: {
  stackNames: string[];
  /** Desired and physical identities resolved by the current checkout. */
  current: { compatibilityIds: ReadonlySet<string>; projects: ReadonlySet<string> };
  inventory: ComposeInventory;
  registry: LineageRegistry;
  stackDirectories: string[];
  consumers: (projectName: string) => LeaseConsumer[];
}): DefinitionCleanup[] {
  const isOurs = (projectName: string) =>
    options.stackNames.some((name) => isMachineVariantName(name, projectName));
  const inUse = (projectName: string) =>
    options.current.projects.has(projectName) ||
    options.current.compatibilityIds.has(projectName) ||
    !composeProjectIsEmpty(options.inventory, projectName) ||
    options
      .consumers(projectName)
      .some((consumer) => consumer.state !== "stale");

  const plan: DefinitionCleanup[] = [];
  const keptSelections = new Map(Object.entries(options.registry.selections));

  for (const [compatibilityId, selection] of Object.entries(
    options.registry.selections,
  )) {
    if (!isOurs(selection.projectName)) continue;
    if (options.current.compatibilityIds.has(compatibilityId)) continue;
    if (inUse(selection.projectName)) continue;
    plan.push({
      projectName: selection.projectName,
      action: "remove-selection",
      compatibilityId,
    });
    keptSelections.delete(compatibilityId);
  }

  const referenced = new Set<string>();
  for (const [compatibilityId, selection] of keptSelections) {
    referenced.add(compatibilityId);
    referenced.add(selection.projectName);
  }

  for (const directory of [...options.stackDirectories].sort()) {
    if (!isOurs(directory)) continue;
    if (referenced.has(directory) || inUse(directory)) continue;
    plan.push({ projectName: directory, action: "remove-definition" });
  }

  return plan;
}

export function listStackDirectories(): string[] {
  try {
    return fs
      .readdirSync(homePaths.stacks(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

export async function currentDefinitionCleanup(options: {
  engine: ContainerEngine;
  stackNames: string[];
  current: { compatibilityIds: ReadonlySet<string>; projects: ReadonlySet<string> };
  inventory?: ComposeInventory;
}): Promise<DefinitionCleanup[]> {
  return planMachineDefinitionCleanup({
    stackNames: options.stackNames,
    current: options.current,
    inventory: options.inventory ?? (await readComposeInventory(options.engine)),
    registry: readLineageRegistry(),
    stackDirectories: listStackDirectories(),
    consumers: consumersForProject,
  });
}

/**
 * Apply a definition cleanup. Each step re-checks emptiness under the stack's
 * lock, so an `up` that started the variant in the meantime wins.
 */
export async function applyDefinitionCleanup(
  engine: ContainerEngine,
  plan: DefinitionCleanup[],
): Promise<Array<DefinitionCleanup & { applied: boolean }>> {
  const results: Array<DefinitionCleanup & { applied: boolean }> = [];
  for (const step of plan) {
    const applied = await withLock(step.projectName, async () => {
      const inventory = await readComposeInventory(engine);
      if (!composeProjectIsEmpty(inventory, step.projectName)) return false;
      if (step.action === "remove-selection") {
        removeLineageSelection(step.compatibilityId!);
      } else {
        fs.rmSync(homePaths.stack(step.projectName), {
          recursive: true,
          force: true,
        });
      }
      return true;
    });
    results.push({ ...step, applied });
  }
  return results;
}

/**
 * Remove a workspace-scoped Compose project of a pruned worktree: containers,
 * networks, and named volumes carrying its Compose project label, plus its
 * generated definition. Selection by label means no Compose file is needed.
 */
export async function removeWorkspaceComposeProject(
  engine: ContainerEngine,
  projectName: string,
): Promise<void> {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(projectName)) {
    throw new WorkTrellisError(`Refusing to remove invalid Compose project "${projectName}".`);
  }
  const filter = `label=com.docker.compose.project=${projectName}`;

  const list = async (args: string[]): Promise<string[]> => {
    const result = await run(engine.cli, [...args, "--filter", filter, "-q"], {
      quiet: true,
      timeoutMs: 60_000,
    });
    if (result.code !== 0) {
      throw new WorkTrellisError(`Could not list resources of ${projectName}.`, {
        remediation: result.stderr.trim().split("\n")[0],
      });
    }
    return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  };
  const remove = async (args: string[], ids: string[]): Promise<void> => {
    if (ids.length === 0) return;
    const result = await run(engine.cli, [...args, ...ids], {
      quiet: true,
      timeoutMs: 120_000,
    });
    if (result.code !== 0) {
      throw new WorkTrellisError(`Could not remove resources of ${projectName}.`, {
        remediation: result.stderr.trim().split("\n")[0],
      });
    }
  };

  await withLock(projectName, async () => {
    await remove(["rm", "-f"], await list(["ps", "-a"]));
    await remove(["network", "rm"], await list(["network", "ls"]));
    await remove(["volume", "rm"], await list(["volume", "ls"]));
    fs.rmSync(homePaths.stack(projectName), { recursive: true, force: true });
  });
}
