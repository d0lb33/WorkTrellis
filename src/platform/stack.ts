import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";

import type {
  ComposeContext,
  ComposeStackSpec,
  InfrastructureScope,
  WorkspaceIdentity,
} from "../types";
import { conflictError, WorkTrellisError } from "../core/errors";
import { withLock } from "../core/lock";
import { homePaths } from "../core/state";
import { c, info, step, warn } from "../util/log";
import { readJsonFile } from "../util/fs";
import {
  replaceProjectLineageSelection,
  selectedLineage,
} from "./lineage-state";
import {
  assessReconciliation,
  listMachineVariants,
  readStackPorts,
  reconcileMachineLineage,
  retainedConflicts,
  type MachineVariant,
} from "./lineage";
import { run } from "../util/proc";
import { ComposeStack } from "./compose";
import { renderStack, type RenderedStack } from "./compose-render";
import {
  assertDaemonRunning,
  detectEngine,
  type ContainerEngine,
} from "./engine";
import {
  hostForUrl,
  resolveEngineEndpoint,
  type EngineEndpoint,
} from "./engine-endpoint";
import { probePort, waitForPortProbe } from "./health";
import { describePortOwner, whoHolds } from "./port-owner";

export interface StackStatus {
  name: string;
  scope: InfrastructureScope;
  stackId: string;
  compatibilityId: string;
  ports: Record<string, number>;
  running: boolean;
  reachable: boolean;
  detail?: string;
  retainedVariantCount?: number;
}

export interface EnsureResult {
  engine: ContainerEngine;
  endpoint: EngineEndpoint;
  compose: ComposeContext;
  statuses: StackStatus[];
  stacks: Array<{ spec: ComposeStackSpec; stack: ComposeStack }>;
  remoteEngineNote?: string;
}

export interface MachineStackVariant {
  stackId: string;
  projectFilesMatch: boolean;
}

type VariantChoice =
  | { kind: "fresh" }
  | { kind: "reconcile"; projectName: string };

async function resolveVariantChoice(options: {
  spec: ComposeStackSpec;
  conflicts: MachineVariant[];
  interactive: boolean;
}): Promise<VariantChoice> {
  const canPrompt =
    options.interactive &&
    process.stdin.isTTY === true &&
    process.stdout.isTTY === true &&
    !process.env.CI;
  const projects = options.conflicts.map((variant) => variant.projectName);
  if (!canPrompt) {
    conflictError(
      `Machine stack "${options.spec.name}" has retained data in another compatibility variant.`,
      [
        ...projects.map((project) => `  ${project}`),
        "Choose explicitly:",
        `  worktrellis services reconcile ${options.spec.name} --from <project>`,
        `  worktrellis up --new-variant ${options.spec.name}`,
      ].join("\n"),
    );
  }

  info("");
  warn(
    `Machine stack "${options.spec.name}" has retained containers or volumes in another definition.`,
  );
  options.conflicts.forEach((variant, index) => {
    const state = variant.running ? "running" : "stopped";
    info(
      `  ${index + 1}. ${c.cyan(variant.projectName)}  ${state}  ${variant.volumes.length} volume(s)`,
    );
    if (variant.reconcileSafe === false) {
      info(c.gray(`     cannot reconcile: ${variant.reconcileReason}`));
    }
  });

  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const safe = options.conflicts.filter(
      (variant) => variant.reconcileSafe === true,
    );
    if (safe.length === 0) {
      const answer = (
        await readline.question("[n] start fresh, [Enter] cancel: ")
      )
        .trim()
        .toLowerCase();
      if (answer === "n") return { kind: "fresh" };
      conflictError("Machine-stack selection cancelled.");
    }
    let source = safe[0]!;
    if (safe.length > 1) {
      const selected = (
        await readline.question("Select a lineage number to reconcile, or press Enter to cancel: ")
      ).trim();
      if (!/^\d+$/.test(selected)) {
        conflictError("Machine-stack selection cancelled.");
      }
      const candidate = options.conflicts[Number(selected) - 1];
      if (!candidate) conflictError("Machine-stack selection cancelled.");
      if (candidate.reconcileSafe !== true) {
        conflictError(`${candidate.projectName} is not safe to reconcile.`);
      }
      source = candidate;
    }
    const answer = (
      await readline.question(
        `[r] reconcile ${source.projectName}, [n] start fresh, [Enter] cancel: `,
      )
    )
      .trim()
      .toLowerCase();
    if (answer === "r") {
      return { kind: "reconcile", projectName: source.projectName };
    }
    if (answer === "n") return { kind: "fresh" };
    conflictError("Machine-stack selection cancelled.");
  } finally {
    readline.close();
  }
}

function machineStackPrefix(rendered: RenderedStack): string | null {
  const prefix = `worktrellis-machine-${rendered.name}-`;
  // Machine stack IDs normally end with the first eight characters of their
  // compatibility hash. Very long names are compacted as a whole and cannot
  // be grouped safely without persisted metadata.
  return prefix.length + 8 <= 63 ? prefix : null;
}

function projectFilesMatch(
  rendered: RenderedStack,
  existingDirectory: string,
): boolean {
  const current = rendered.files.filter(
    (file) => file.name !== "99-worktrellis-ports.compose.yml",
  );
  const names =
    readJsonFile<string[]>(path.join(existingDirectory, "files.json"))?.filter(
      (name) => name !== "99-worktrellis-ports.compose.yml",
    ) ?? [];

  if (
    names.length !== current.length ||
    names.some((name, index) => name !== current[index]?.name)
  ) {
    return false;
  }

  try {
    return current.every(
      (file) =>
        fs.readFileSync(path.join(existingDirectory, file.name), "utf8") ===
        file.contents,
    );
  } catch {
    return false;
  }
}

export function findRunningMachineStackVariants(
  rendered: RenderedStack,
  runningProjectIds: ReadonlySet<string>,
): MachineStackVariant[] {
  if (rendered.scope !== "machine") return [];
  const prefix = machineStackPrefix(rendered);
  if (!prefix) return [];

  return [...runningProjectIds]
    .filter(
      (stackId) =>
        stackId !== rendered.stackId &&
        stackId.startsWith(prefix) &&
        /^[a-f0-9]{8}$/.test(stackId.slice(prefix.length)),
    )
    .sort()
    .map((stackId) => ({
      stackId,
      projectFilesMatch: projectFilesMatch(
        rendered,
        homePaths.stack(stackId),
      ),
    }));
}

export function describeMachineStackVariants(
  rendered: RenderedStack,
  variants: MachineStackVariant[],
): string {
  const ids = variants.map((variant) => variant.stackId).join(", ");
  const projectFilesMatch = variants.every(
    (variant) => variant.projectFilesMatch,
  );
  const envKeys = Object.keys(rendered.composeEnvironment).sort();

  const difference = projectFilesMatch
    ? `The project Compose files match, so named-port declarations or resolved \`compose.env\` values differ${
        envKeys.length > 0 ? ` (${envKeys.join(", ")})` : ""
      }. If those values read \`baseEnv\`, compare the worktrees' .env files.`
    : "The project Compose definitions differ from the running variant.";

  return [
    `Another machine-scoped "${rendered.name}" variant is already running: ${ids}.`,
    `This checkout resolved ${rendered.stackId}, so starting it creates another set of containers and volumes.`,
    difference,
  ].join("\n    ");
}

async function runningComposeProjectIds(
  engine: ContainerEngine,
): Promise<Set<string>> {
  const result = await run(
    engine.cli,
    [
      "ps",
      "--format",
      '{{.Label "com.docker.compose.project"}}',
    ],
    { quiet: true, timeoutMs: 30_000 },
  ).catch(() => null);

  if (!result || result.code !== 0) return new Set();
  return new Set(
    result.stdout
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

export async function ensureInfrastructure(
  specs: ComposeStackSpec[],
  options: {
    identity: WorkspaceIdentity;
    projectRoot: string;
    baseEnv?: Readonly<Record<string, string>>;
    endpoint?: EngineEndpoint;
    allowStaleEndpoint?: boolean;
    startIfStopped?: boolean;
    allowNewMachineVariants?: readonly string[];
    interactive?: boolean;
  },
): Promise<EnsureResult> {
  const startIfStopped = options.startIfStopped ?? true;
  const engine = await detectEngine();
  await assertDaemonRunning(engine);
  const endpoint =
    options.endpoint ??
    (await resolveEngineEndpoint(engine, {
      allowStale: options.allowStaleEndpoint,
    }));
  const host = endpoint.connectHost;
  const remoteEngineNote =
    endpoint.isRemote
      ? `container engine is remote (${endpoint.contextName}); published ports bind ${endpoint.bindAddress} and are reached at ${endpoint.connectHost}`
      : undefined;

  const stacks: Array<{ spec: ComposeStackSpec; stack: ComposeStack }> = [];
  const statuses: StackStatus[] = [];

  const unknownFreshVariants = (options.allowNewMachineVariants ?? []).filter(
    (name) =>
      !specs.some((spec) => spec.name === name && spec.scope === "machine"),
  );
  if (unknownFreshVariants.length > 0) {
    throw new WorkTrellisError(
      `--new-variant names unknown machine stack(s): ${unknownFreshVariants.join(", ")}.`,
    );
  }

  for (const spec of specs) {
    let stack = stackFor(
      engine,
      spec,
      options.projectRoot,
      options.identity,
      options.baseEnv,
      endpoint.bindAddress,
    );
    if (startIfStopped && spec.scope === "machine") {
      const variants = await listMachineVariants({
        engine,
        rendered: stack.rendered,
      });
      if (!selectedLineage(stack.rendered.compatibilityId)) {
        const exact = variants.filter(
          (variant) => variant.retained && variant.compatibility === "current",
        );
        const automatic =
          exact.find(
            (variant) =>
              variant.projectName === stack.rendered.compatibilityId,
          ) ?? (exact.length === 1 ? exact[0] : undefined);
        if (automatic) {
          replaceProjectLineageSelection({
            compatibilityId: stack.rendered.compatibilityId,
            projectName: automatic.projectName,
            ports: readStackPorts(
              automatic.projectName,
              stack.rendered.portSpecs,
            ),
            selectedAt: new Date().toISOString(),
          });
          stack = stackFor(
            engine,
            spec,
            options.projectRoot,
            options.identity,
            options.baseEnv,
            endpoint.bindAddress,
          );
        }
      }
      const conflicts = retainedConflicts(stack.rendered, variants);
      if (conflicts.length > 0) {
        const allowFresh = options.allowNewMachineVariants?.includes(spec.name);
        if (!allowFresh) {
          for (const conflict of conflicts) {
            const assessment = await assessReconciliation({
              engine,
              spec,
              projectRoot: options.projectRoot,
              identity: options.identity,
              baseEnv: options.baseEnv ?? {},
              sourceProject: conflict.projectName,
              bindAddress: endpoint.bindAddress,
            });
            conflict.reconcileSafe = assessment.safe;
            conflict.reconcileReason = assessment.reason;
          }
          const choice = await resolveVariantChoice({
            spec,
            conflicts,
            interactive: options.interactive ?? true,
          });
          if (choice.kind === "reconcile") {
            await reconcileMachineLineage({
              engine,
              spec,
              projectRoot: options.projectRoot,
              identity: options.identity,
              baseEnv: options.baseEnv ?? {},
              sourceProject: choice.projectName,
              bindAddress: endpoint.bindAddress,
            });
            stack = stackFor(
              engine,
              spec,
              options.projectRoot,
              options.identity,
              options.baseEnv,
              endpoint.bindAddress,
            );
          }
        }
      }
    }
    stacks.push({ spec, stack });
    const { rendered } = stack;
    // Inspection must not create or rewrite machine state. Mutating commands
    // sync only after variant selection has been resolved.
    const specChanged = startIfStopped
      ? stack.sync()
      : !stack.matchesDefinition();
    let healthy = await stack.isHealthy();
    if (!healthy && startIfStopped) {
      await assertPortsAvailable(
        spec,
        stack,
        engine,
        endpoint.bindAddress,
        endpoint.isRemote,
      );

      await withLock(rendered.stackId, async () => {
        if (await stack.isHealthy()) return;
        step("compose", `starting ${c.cyan(rendered.stackId)}`);
        await stack.up();
      });

      healthy = await stack.isHealthy();
    } else if (specChanged && healthy) {
      warn(
        `${rendered.stackId} is running with an older definition. Run \`worktrellis services restart\` to apply the change.`,
      );
    }

    const probes = await Promise.all(
      Object.entries(rendered.ports).map(async ([name, port]) => {
        const portSpec = rendered.portSpecs[name];
        const probe =
          portSpec?.probe ??
          (portSpec?.protocol === "udp" ? { kind: "none" as const } : undefined);
        const result = healthy
          ? await waitForPortProbe(probe, port, {
              timeoutMs: 30_000,
              host,
            })
          : await probePort(probe, port, host);
        return { name, ...result };
      }),
    );
    const failed = probes.filter((probe) => !probe.reachable);

    if (
      startIfStopped &&
      spec.scope === "machine" &&
      healthy &&
      failed.length === 0 &&
      !selectedLineage(rendered.compatibilityId)
    ) {
      replaceProjectLineageSelection({
        compatibilityId: rendered.compatibilityId,
        projectName: rendered.stackId,
        ports: { ...rendered.ports },
        selectedAt: new Date().toISOString(),
      });
    }

    const retainedVariantCount =
      spec.scope === "machine"
        ? (
            await listMachineVariants({ engine, rendered })
          ).filter(
            (variant) =>
              variant.retained && variant.projectName !== rendered.stackId,
          ).length
        : 0;
    statuses.push({
      name: spec.name,
      scope: spec.scope,
      stackId: rendered.stackId,
      compatibilityId: rendered.compatibilityId,
      ports: rendered.ports,
      running: healthy,
      reachable: healthy && failed.length === 0,
      retainedVariantCount,
      detail:
        failed.length > 0
          ? failed
              .map(
                (probe) =>
                  `${probe.name}: ${probe.detail ?? "not reachable"}`,
              )
              .join("; ")
          : undefined,
    });
  }

  const unreachable = statuses.filter(
    (status) => status.running && !status.reachable,
  );
  if (unreachable.length > 0 && remoteEngineNote) {
    warn(
      `${unreachable.map((status) => status.name).join(", ")} report healthy containers but are not reachable from this machine.`,
    );
    warn(`  ${remoteEngineNote}`);
  }

  return {
    engine,
    endpoint,
    compose: composeContext(stacks, host),
    statuses,
    stacks,
    remoteEngineNote,
  };
}

function composeContext(
  stacks: Array<{ spec: ComposeStackSpec; stack: ComposeStack }>,
  host: string,
): ComposeContext {
  const resolved = Object.fromEntries(
    stacks.map(({ spec, stack }) => [
      spec.name,
      {
        name: spec.name,
        scope: spec.scope,
        compatibilityId: stack.rendered.compatibilityId,
        projectName: stack.rendered.stackId,
        ports: Object.freeze({ ...stack.rendered.ports }),
      },
    ]),
  );

  return {
    host,
    stacks: Object.freeze(resolved),
    url(stackName, portName, scheme = "http") {
      const stack = resolved[stackName];
      if (!stack) {
        throw new WorkTrellisError(
          `Unknown Compose stack "${stackName}" in env profile.`,
        );
      }
      const port = stack.ports[portName];
      if (!port) {
        throw new WorkTrellisError(
          `Unknown Compose port "${stackName}.${portName}" in env profile.`,
        );
      }
      return `${scheme}://${hostForUrl(host)}:${port}`;
    },
  };
}

async function assertPortsAvailable(
  spec: ComposeStackSpec,
  stack: ComposeStack,
  engine: ContainerEngine,
  bindAddress: string,
  remote = false,
): Promise<void> {
  for (const [name, port] of Object.entries(stack.rendered.ports)) {
    const owner = await whoHolds(port, {
      engine,
      ourStackIds: [stack.rendered.stackId],
      protocol: stack.rendered.portSpecs[name]?.protocol ?? "tcp",
      bindAddress,
      checkLocalProcesses: !remote,
    });
    if (owner.kind === "free" || owner.kind === "our-stack") continue;

    if (owner.kind === "other-compose") {
      conflictError(
        `Cannot start ${spec.name}: ${describePortOwner(port, owner)}.`,
        `Stop it with:\n  docker compose -p ${owner.project} down\nOr record a machine override:\n  worktrellis services adopt --${name}-port <port>`,
      );
    }

    conflictError(
      `Cannot start ${spec.name}: ${describePortOwner(port, owner)}.`,
      `Stop that process, or record a machine override:\n  worktrellis services adopt --${name}-port <port>`,
    );
  }
}

export function stackFor(
  engine: ContainerEngine,
  spec: ComposeStackSpec,
  projectRoot: string,
  identity: WorkspaceIdentity,
  baseEnv?: Readonly<Record<string, string>>,
  bindAddress = "127.0.0.1",
): ComposeStack {
  const desired = renderStack({
    spec,
    projectRoot,
    identity,
    baseEnv,
    bindAddress,
  });
  const selection =
    spec.scope === "machine"
      ? selectedLineage(desired.compatibilityId)
      : null;
  return new ComposeStack(
    engine,
    selection
      ? renderStack({
          spec,
          projectRoot,
          identity,
          baseEnv,
          bindAddress,
          physicalProjectName: selection.projectName,
          physicalPorts: selection.ports,
        })
      : desired,
  );
}

export function assertKnownStack(
  name: string,
  stacks: Array<{ spec: ComposeStackSpec; stack: ComposeStack }>,
): { spec: ComposeStackSpec; stack: ComposeStack } {
  const found = stacks.find(({ spec }) => spec.name === name);
  if (!found) {
    throw new WorkTrellisError(`This project does not declare stack "${name}".`, {
      remediation: `Declared stacks: ${stacks
        .map(({ spec }) => spec.name)
        .join(", ")}`,
    });
  }
  return found;
}
