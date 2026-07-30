import type {
  ComposeContext,
  ComposeStackSpec,
  InfrastructureScope,
  WorkspaceIdentity,
} from "../types";
import { conflictError, WorkTrellisError } from "../core/errors";
import { withLock } from "../core/lock";
import { c, step, warn } from "../util/log";
import { ComposeStack } from "./compose";
import { renderStack } from "./compose-render";
import {
  assertDaemonRunning,
  detectEngine,
  engineContext,
  type ContainerEngine,
} from "./engine";
import { probePort, waitForPortProbe } from "./health";
import { describePortOwner, whoHolds } from "./port-owner";

export interface StackStatus {
  name: string;
  scope: InfrastructureScope;
  stackId: string;
  ports: Record<string, number>;
  running: boolean;
  reachable: boolean;
  detail?: string;
}

export interface EnsureResult {
  engine: ContainerEngine;
  compose: ComposeContext;
  statuses: StackStatus[];
  stacks: Array<{ spec: ComposeStackSpec; stack: ComposeStack }>;
  remoteEngineNote?: string;
}

export async function ensureInfrastructure(
  specs: ComposeStackSpec[],
  options: {
    identity: WorkspaceIdentity;
    projectRoot: string;
    baseEnv?: Readonly<Record<string, string>>;
    host?: string;
    startIfStopped?: boolean;
  },
): Promise<EnsureResult> {
  const host = options.host ?? "127.0.0.1";
  const startIfStopped = options.startIfStopped ?? true;
  const engine = await detectEngine();
  await assertDaemonRunning(engine);

  const context = await engineContext(engine);
  const remoteEngineNote =
    context?.isRemote === true
      ? `container engine is remote (${context.name} -> ${context.endpoint}); published ports live on that host`
      : undefined;

  const stacks = specs.map((spec) => ({
    spec,
    stack: stackFor(
      engine,
      spec,
      options.projectRoot,
      options.identity,
      options.baseEnv,
    ),
  }));
  const statuses: StackStatus[] = [];

  for (const { spec, stack } of stacks) {
    const { rendered } = stack;
    const specChanged = stack.sync();
    let healthy = await stack.isHealthy();

    if (!healthy && startIfStopped) {
      await assertPortsAvailable(spec, stack, engine);

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

    statuses.push({
      name: spec.name,
      scope: spec.scope,
      stackId: rendered.stackId,
      ports: rendered.ports,
      running: healthy,
      reachable: healthy && failed.length === 0,
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
        projectName: stack.rendered.stackId,
        ports: Object.freeze({ ...stack.rendered.ports }),
      },
    ]),
  );

  return {
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
      return `${scheme}://${host}:${port}`;
    },
  };
}

async function assertPortsAvailable(
  spec: ComposeStackSpec,
  stack: ComposeStack,
  engine: ContainerEngine,
): Promise<void> {
  for (const [name, port] of Object.entries(stack.rendered.ports)) {
    const owner = await whoHolds(port, {
      engine,
      ourStackIds: [stack.rendered.stackId],
      protocol: stack.rendered.portSpecs[name]?.protocol ?? "tcp",
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
): ComposeStack {
  return new ComposeStack(
    engine,
    renderStack({ spec, projectRoot, identity, baseEnv }),
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
