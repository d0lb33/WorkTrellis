import fs from "node:fs";

import type {
  AnyResourceAdapter,
  ResolvedComposeStack,
  ResourceDeprovisionResult,
} from "../types";
import { EXIT } from "../core/errors";
import { redactDiagnosticText } from "../core/env-resolve";
import {
  identityFromRecord,
  resolveMaxIdleDays,
  selectPruneCandidates,
  type PruneCandidate,
  type PruneSkip,
} from "../core/gc";
import { withLock } from "../core/lock";
import { prepareWorkspace } from "../core/prepare";
import {
  homePaths,
  readWorkspaceRecords,
  removeWorkspaceRecord,
  type WorkspaceRecord,
} from "../core/state";
import {
  applyDefinitionCleanup,
  composeProjectIsEmpty,
  currentDefinitionCleanup,
  removeWorkspaceComposeProject,
  type DefinitionCleanup,
} from "../platform/cleanup";
import { readComposeInventory, type ComposeInventory } from "../platform/lineage";
import {
  classifyLease,
  clearMachineRunLease,
  readMachineRunLeases,
  workspaceLeaseState,
} from "../platform/lineage-state";
import { resolveResourceEndpoint, resolveResources } from "../resources";
import { c, heading, info, success, warn } from "../util/log";

export interface PruneOptions {
  cwd?: string;
  configPath?: string;
  json?: boolean;
  /** Without it, prune only reports. */
  yes?: boolean;
  maxIdleDays?: string;
}

export type ResourceOutcome =
  | ResourceDeprovisionResult["status"]
  /** The adapter has no deprovision hook, so the resource is left alone. */
  | "retained"
  /** Its endpoint is not reachable now; try again once the stack runs. */
  | "unavailable"
  /** Provisioned in another Compose project that still exists. */
  | "elsewhere"
  | "failed";

/** Outcomes that keep the workspace record so a later prune can retry. */
const BLOCKING: ReadonlySet<ResourceOutcome> = new Set([
  "refused",
  "unavailable",
  "elsewhere",
  "failed",
]);

export interface PrunedResource {
  name: string;
  kind: string;
  status: ResourceOutcome;
  detail?: string;
  bytes?: number;
}

export interface PrunedStack {
  name: string;
  projectName: string;
  status: "removed" | "would-remove" | "absent" | "failed";
  containers: number;
  volumes: number;
  detail?: string;
}

export interface PrunedWorkspace {
  slug: string;
  branch: string | null;
  worktreeRoot: string;
  reason: PruneCandidate["reason"];
  idleDays?: number;
  resources: PrunedResource[];
  stacks: PrunedStack[];
  record: "removed" | "would-remove" | "kept";
}

export interface PruneReport {
  project: string;
  dryRun: boolean;
  maxIdleDays: number | null;
  workspaces: PrunedWorkspace[];
  skipped: Array<{ slug: string; worktreeRoot: string; reason: string }>;
  staleLeases: { count: number; status: "removed" | "would-remove" | "none" };
  definitions: Array<DefinitionCleanup & { status: "removed" | "would-remove" | "kept" }>;
  /** Bytes the removed (or, in a dry run, removable) resources reported. */
  reclaimableBytes: number;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  const units = ["kB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = -1;
  while (value >= 1_000 && unit < units.length - 1) {
    value /= 1_000;
    unit += 1;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

/**
 * Where a candidate's resource lived. A record written by a client that knew
 * its Compose projects says which physical project held each stack; anything
 * else is assumed to be the project this checkout resolves now.
 */
export function resourceLocation(options: {
  record: WorkspaceRecord;
  adapter: AnyResourceAdapter;
  current: ResolvedComposeStack | undefined;
  inventory: ComposeInventory;
}): { status: "here" } | { status: "gone" | "elsewhere"; projectName: string } {
  const recorded = options.record.composeProjects?.find(
    (entry) => entry.name === options.adapter.endpoint.stack,
  );
  if (!recorded || recorded.projectName === options.current?.projectName) {
    return { status: "here" };
  }
  return composeProjectIsEmpty(options.inventory, recorded.projectName)
    ? { status: "gone", projectName: recorded.projectName }
    : { status: "elsewhere", projectName: recorded.projectName };
}

export async function runPrune(options: PruneOptions): Promise<number> {
  const dryRun = options.yes !== true;
  const prepared = await prepareWorkspace({
    cwd: options.cwd,
    configPath: options.configPath,
    // Prune never starts or stops shared infrastructure.
    startServices: false,
    peekUrl: true,
    writeSnapshotFile: false,
  });
  const { context, infrastructure, env } = prepared;
  const { config, identity } = context;
  const maxIdleDays = resolveMaxIdleDays(options.maxIdleDays, config);
  const engine = infrastructure.engine;
  const redact = (text: string) =>
    redactDiagnosticText(text, env.combined, prepared.envContext.resources);

  const work = async (): Promise<PruneReport> => {
    const selection = selectPruneCandidates({
      records: readWorkspaceRecords({ project: config.project }),
      project: config.project,
      current: { repoKey: identity.repoKey, slug: identity.slug },
      maxIdleDays,
      now: Date.now(),
      leaseState: (record) => workspaceLeaseState(record.repoKey, record.slug),
    });
    const inventory = await readComposeInventory(engine);
    const reachable = new Map(
      infrastructure.statuses.map((status) => [status.name, status.reachable]),
    );
    const scopes = new Map(config.compose.map((spec) => [spec.name, spec.scope]));
    const currentProjects = new Set(
      infrastructure.stacks.map(({ stack }) => stack.rendered.stackId),
    );

    const workspaces: PrunedWorkspace[] = [];
    for (const candidate of selection.candidates) {
      workspaces.push(
        await pruneWorkspace({
          candidate,
          dryRun,
          adapters: config.resources ?? {},
          prepared,
          inventory,
          reachable,
          scopes,
          currentProjects,
          redact,
        }),
      );
    }

    // Supervisors that exited without clearing their lease are not consumers.
    const stale = readMachineRunLeases().filter(
      (lease) =>
        lease.project === config.project &&
        classifyLease(lease).state === "stale",
    );
    if (!dryRun) {
      for (const lease of stale) clearMachineRunLease(lease.repoKey, lease.slug);
    }

    const machineStacks = config.compose
      .filter((spec) => spec.scope === "machine")
      .map((spec) => spec.name);
    const plan = await currentDefinitionCleanup({
      engine,
      stackNames: machineStacks,
      current: {
        compatibilityIds: new Set(
          infrastructure.stacks.map(({ stack }) => stack.rendered.compatibilityId),
        ),
        projects: currentProjects,
      },
      inventory,
    });
    const definitions = dryRun
      ? plan.map((step) => ({ ...step, status: "would-remove" as const }))
      : (await applyDefinitionCleanup(engine, plan)).map(({ applied, ...step }) => ({
          ...step,
          status: applied ? ("removed" as const) : ("kept" as const),
        }));

    const reclaimableBytes = workspaces
      .flatMap((workspace) => workspace.resources)
      .filter((resource) =>
        resource.status === "removed" || resource.status === "would-remove",
      )
      .reduce((total, resource) => total + (resource.bytes ?? 0), 0);

    return {
      project: config.project,
      dryRun,
      maxIdleDays: maxIdleDays ?? null,
      workspaces,
      skipped: selection.skipped.map((skip: PruneSkip) => ({
        slug: skip.record.slug,
        worktreeRoot: skip.record.worktreeRoot,
        reason: skip.reason,
      })),
      staleLeases: {
        count: stale.length,
        status: stale.length === 0 ? "none" : dryRun ? "would-remove" : "removed",
      },
      definitions,
      reclaimableBytes,
    };
  };

  // One prune per project at a time; dry runs take no lock.
  const report = dryRun
    ? await work()
    : await withLock(`prune-${config.project}`, work);

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    renderReport(report, infrastructure.statuses);
  }

  if (dryRun) return EXIT.ok;
  return report.workspaces.some((workspace) => workspace.record === "kept")
    ? EXIT.checkFailed
    : EXIT.ok;
}

async function pruneWorkspace(options: {
  candidate: PruneCandidate;
  dryRun: boolean;
  adapters: Record<string, AnyResourceAdapter>;
  prepared: Awaited<ReturnType<typeof prepareWorkspace>>;
  inventory: ComposeInventory;
  reachable: Map<string, boolean>;
  scopes: Map<string, string>;
  currentProjects: ReadonlySet<string>;
  redact: (text: string) => string;
}): Promise<PrunedWorkspace> {
  const { candidate, dryRun, prepared } = options;
  const { record } = candidate;
  const workspace = identityFromRecord(record);
  const compose = prepared.infrastructure.compose;
  const baseEnv = prepared.envContext.baseEnv;

  const resources: PrunedResource[] = [];
  let resolved: Record<string, unknown> = {};
  let resolveError: string | null = null;
  try {
    resolved = resolveResources({
      adapters: options.adapters,
      compose,
      identity: workspace,
      baseEnv,
    }) as Record<string, unknown>;
  } catch (caught) {
    resolveError = options.redact((caught as Error).message);
  }

  for (const [name, adapter] of Object.entries(options.adapters)) {
    const base = { name, kind: adapter.kind };
    if (!adapter.deprovision) {
      resources.push({ ...base, status: "retained", detail: "adapter cannot remove it" });
      continue;
    }
    if (resolveError) {
      resources.push({ ...base, status: "failed", detail: resolveError });
      continue;
    }
    const location = resourceLocation({
      record,
      adapter,
      current: compose.stacks[adapter.endpoint.stack],
      inventory: options.inventory,
    });
    if (location.status === "gone") {
      resources.push({
        ...base,
        status: "absent",
        detail: `its stack ${location.projectName} no longer exists`,
      });
      continue;
    }
    if (location.status === "elsewhere") {
      resources.push({
        ...base,
        status: "elsewhere",
        detail: `provisioned in ${location.projectName}; prune from a checkout that uses it`,
      });
      continue;
    }
    if (!options.reachable.get(adapter.endpoint.stack)) {
      resources.push({
        ...base,
        status: "unavailable",
        detail: `stack ${adapter.endpoint.stack} is not reachable; start it with \`worktrellis services up\``,
      });
      continue;
    }

    try {
      const result = await adapter.deprovision(resolved[name], {
        workspace,
        compose,
        baseEnv,
        dryRun,
        endpoint: resolveResourceEndpoint(compose, adapter.endpoint),
      });
      resources.push({
        ...base,
        status: result.status,
        ...(result.detail ? { detail: options.redact(result.detail) } : {}),
        ...(result.bytes !== undefined ? { bytes: result.bytes } : {}),
      });
    } catch (caught) {
      resources.push({
        ...base,
        status: "failed",
        detail: options.redact((caught as Error).message),
      });
    }
  }

  // A workspace-scoped stack belongs to this worktree alone.
  const stacks: PrunedStack[] = [];
  for (const entry of record.composeProjects ?? []) {
    if (options.scopes.get(entry.name) !== "workspace") continue;
    if (options.currentProjects.has(entry.projectName)) continue;
    const containers = options.inventory.containers.get(entry.projectName)?.total ?? 0;
    const volumes = options.inventory.volumes.get(entry.projectName)?.size ?? 0;
    const definition = fs.existsSync(homePaths.stack(entry.projectName));
    const base = { name: entry.name, projectName: entry.projectName, containers, volumes };
    if (containers === 0 && volumes === 0 && !definition) {
      stacks.push({ ...base, status: "absent" });
    } else if (dryRun) {
      stacks.push({ ...base, status: "would-remove" });
    } else {
      try {
        await removeWorkspaceComposeProject(prepared.infrastructure.engine, entry.projectName);
        stacks.push({ ...base, status: "removed" });
      } catch (caught) {
        stacks.push({
          ...base,
          status: "failed",
          detail: options.redact((caught as Error).message),
        });
      }
    }
  }

  const blocked =
    resources.some((resource) => BLOCKING.has(resource.status)) ||
    stacks.some((stack) => stack.status === "failed");

  let recordStatus: PrunedWorkspace["record"] = "kept";
  if (!blocked) {
    if (dryRun) {
      recordStatus = "would-remove";
    } else {
      // The lease is stale or absent; selection refused live ones.
      clearMachineRunLease(record.repoKey, record.slug);
      fs.rmSync(homePaths.workspaceLogs(`${record.project}-${record.slug}`), {
        recursive: true,
        force: true,
      });
      removeWorkspaceRecord(record.repoKey, record.slug);
      recordStatus = "removed";
    }
  }

  return {
    slug: record.slug,
    branch: record.branch,
    worktreeRoot: record.worktreeRoot,
    reason: candidate.reason,
    ...(candidate.idleDays !== undefined ? { idleDays: candidate.idleDays } : {}),
    resources,
    stacks,
    record: recordStatus,
  };
}

const STATUS_LABEL: Record<ResourceOutcome | PrunedStack["status"], string> = {
  removed: c.green("removed"),
  "would-remove": c.yellow("would remove"),
  absent: c.gray("already gone"),
  refused: c.red("kept"),
  retained: c.gray("retained"),
  unavailable: c.red("unavailable"),
  elsewhere: c.red("elsewhere"),
  failed: c.red("failed"),
};

function renderReport(
  report: PruneReport,
  statuses: Array<{ name: string; reachable: boolean }>,
): void {
  heading(
    `worktrellis prune  ${c.cyan(report.project)}${report.dryRun ? c.gray("  (dry run)") : ""}`,
  );
  info("");

  if (report.workspaces.length === 0) {
    info(
      `  No deleted${report.maxIdleDays ? ` or idle (${report.maxIdleDays}+ days)` : ""} worktrees to prune.`,
    );
  }

  for (const workspace of report.workspaces) {
    const why =
      workspace.reason === "missing"
        ? c.yellow("deleted")
        : c.yellow(`idle ${workspace.idleDays} days`);
    info(`  ${c.cyan(workspace.slug)}  ${workspace.branch ?? "detached"}  ${why}`);
    info(`    ${c.gray(workspace.worktreeRoot)}`);
    for (const resource of workspace.resources) {
      const size = resource.bytes !== undefined ? `  ${formatBytes(resource.bytes)}` : "";
      const detail = resource.detail ? c.gray(`  ${resource.detail}`) : "";
      info(`    ${resource.name.padEnd(12)} ${STATUS_LABEL[resource.status]}${size}${detail}`);
    }
    for (const stack of workspace.stacks) {
      const detail = stack.detail ? c.gray(`  ${stack.detail}`) : "";
      info(
        `    ${stack.name.padEnd(12)} ${STATUS_LABEL[stack.status]}  ${stack.projectName}  ${stack.containers} container(s), ${stack.volumes} volume(s)${detail}`,
      );
    }
    info(
      `    ${"record".padEnd(12)} ${
        workspace.record === "kept"
          ? c.red("kept until the items above can be pruned")
          : workspace.record === "removed"
            ? c.green("removed")
            : c.yellow("would remove")
      }`,
    );
    info("");
  }

  for (const skip of report.skipped) {
    warn(`${skip.slug} skipped: ${skip.reason}`);
  }

  if (report.staleLeases.count > 0) {
    info(
      `  ${report.staleLeases.count} stale run lease(s): ${
        report.staleLeases.status === "removed" ? c.green("removed") : c.yellow("would remove")
      }`,
    );
  }
  for (const definition of report.definitions) {
    const what =
      definition.action === "remove-selection"
        ? "lineage selection with nothing left"
        : "unused machine-stack definition";
    info(
      `  ${definition.projectName}  ${c.gray(what)}  ${
        definition.status === "removed"
          ? c.green("removed")
          : definition.status === "kept"
            ? c.gray("kept (in use again)")
            : c.yellow("would remove")
      }`,
    );
  }

  const unreachable = statuses.filter((status) => !status.reachable);
  if (unreachable.length > 0 && report.workspaces.length > 0) {
    info("");
    warn(
      `${unreachable.map((status) => status.name).join(", ")} not reachable; resources there were not checked.`,
    );
  }

  info("");
  const total = formatBytes(report.reclaimableBytes);
  if (report.dryRun) {
    if (report.workspaces.length > 0 || report.staleLeases.count > 0 || report.definitions.length > 0) {
      info(`  About ${total} reclaimable. Apply with ${c.cyan("worktrellis prune --yes")}.`);
    }
  } else {
    success(`Reclaimed about ${total}.`);
  }
  info("");
}
