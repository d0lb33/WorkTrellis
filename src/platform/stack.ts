import type { PlatformEndpoints, ServiceSpec } from "../types";
import { conflictError, WorkTrellisError } from "../core/errors";
import { withLock } from "../core/lock";
import { readMachineConfig } from "../core/state";
import { c, step, warn } from "../util/log";
import { ComposeStack } from "./compose";
import {
  renderLegacyStack,
  renderStack,
  type ResolvedPorts,
} from "./compose-render";
import { assertDaemonRunning, detectEngine, engineContext, type ContainerEngine } from "./engine";
import { probeService, waitForService } from "./health";
import { describePortOwner, whoHolds } from "./port-owner";

/** Default published ports, by service kind and role. */
const DEFAULT_PORTS: Record<ServiceSpec["kind"], ResolvedPorts> = {
  postgres: { main: 5432 },
  redis: { main: 6379 },
  minio: { api: 9000, console: 9001 },
  mailpit: { smtp: 1025, ui: 8025 },
};

export function resolvePorts(spec: ServiceSpec): ResolvedPorts {
  const defaults = { ...DEFAULT_PORTS[spec.kind] };
  const overrides = readMachineConfig().portOverrides ?? {};

  // Explicit spec ports win over defaults; a machine-level override wins over
  // both, because it exists precisely to resolve a local collision.
  switch (spec.kind) {
    case "postgres":
      if (spec.port) defaults.main = spec.port;
      if (overrides.postgres) defaults.main = overrides.postgres;
      break;
    case "redis":
      if (spec.port) defaults.main = spec.port;
      if (overrides.redis) defaults.main = overrides.redis;
      break;
    case "minio":
      if (spec.apiPort) defaults.api = spec.apiPort;
      if (spec.consolePort) defaults.console = spec.consolePort;
      if (overrides.minio) defaults.api = overrides.minio;
      if (overrides.minioConsole) defaults.console = overrides.minioConsole;
      break;
    case "mailpit":
      if (spec.smtpPort) defaults.smtp = spec.smtpPort;
      if (spec.uiPort) defaults.ui = spec.uiPort;
      if (overrides.mailpit) defaults.smtp = overrides.mailpit;
      if (overrides.mailpitUi) defaults.ui = overrides.mailpitUi;
      break;
  }

  return defaults;
}

export interface ServiceStatus {
  kind: ServiceSpec["kind"];
  stackId: string;
  ports: ResolvedPorts;
  running: boolean;
  reachable: boolean;
  detail?: string;
}

export interface EnsureResult {
  engine: ContainerEngine;
  endpoints: PlatformEndpoints;
  statuses: ServiceStatus[];
  /** Set when the engine runs somewhere other than this machine. */
  remoteEngineNote?: string;
}

function endpointsFor(
  specs: ServiceSpec[],
  portsByKind: Map<string, ResolvedPorts>,
  host: string,
): PlatformEndpoints {
  const endpoints: PlatformEndpoints = {};

  for (const spec of specs) {
    const ports = portsByKind.get(spec.kind);
    if (!ports) continue;

    switch (spec.kind) {
      case "postgres": {
        const user = spec.superuser ?? "postgres";
        const password = spec.password ?? "postgres";
        endpoints.postgres = {
          host,
          port: ports.main!,
          user,
          password,
          urlFor: (database) =>
            `postgresql://${user}:${password}@${host}:${ports.main}/${database}`,
        };
        break;
      }
      case "redis":
        endpoints.redis = {
          host,
          port: ports.main!,
          urlFor: (db) => `redis://${host}:${ports.main}/${db}`,
        };
        break;
      case "minio":
        endpoints.minio = {
          endpoint: `http://${host}:${ports.api}`,
          consoleUrl: `http://${host}:${ports.console}`,
          accessKey: spec.rootUser ?? "minioadmin",
          secretKey: spec.rootPassword ?? "minioadmin",
          region: spec.region ?? "us-east-1",
        };
        break;
      case "mailpit":
        endpoints.mailpit = {
          smtpHost: host,
          smtpPort: ports.smtp!,
          uiUrl: `http://${host}:${ports.ui}`,
        };
        break;
    }
  }

  return endpoints;
}

/**
 * Bring the shared services up (or confirm they already are) and return the
 * endpoints a project's env profile consumes.
 *
 * Concurrency: two worktrees may run this at the same moment, so each stack is
 * brought up under a machine-wide lock. The common case — everything already
 * healthy — takes the lock briefly and does no compose work at all.
 */
export async function ensureServices(
  specs: ServiceSpec[],
  options: { host?: string; startIfStopped?: boolean } = {},
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

  const stacks = specs.map((spec) => {
    const ports = resolvePorts(spec);
    return { spec, ports, stack: stackFor(engine, spec, ports) };
  });
  const ourStackIds = stacks.map(({ stack }) => stack.rendered.stackId);
  const portsByKind = new Map<string, ResolvedPorts>();
  const statuses: ServiceStatus[] = [];

  for (const { spec, ports, stack } of stacks) {
    portsByKind.set(spec.kind, ports);

    const { rendered } = stack;
    const specChanged = stack.sync();

    let healthy = await stack.isHealthy();

    if (!healthy && startIfStopped) {
      await assertPortsAvailable(spec, ports, engine, ourStackIds);

      await withLock(rendered.stackId, async () => {
        // Another worktree may have started it while we waited for the lock.
        if (await stack.isHealthy()) return;
        step("services", `starting ${c.cyan(rendered.stackId)}`);
        await stack.up();
      }, {
        onWait: (owner) =>
          step(
            "services",
            `waiting for another worktree to start ${rendered.stackId}${
              owner ? ` (pid ${owner.pid})` : ""
            }`,
          ),
      });

      healthy = await stack.isHealthy();
    } else if (specChanged && healthy) {
      warn(
        `${rendered.stackId} is running with an older definition. Run \`worktrellis services restart\` to apply the change.`,
      );
    }

    const probe = healthy
      ? await waitForService(spec.kind, ports, { timeoutMs: 30_000, host })
      : await probeService(spec.kind, ports, host);

    statuses.push({
      kind: spec.kind,
      stackId: rendered.stackId,
      ports,
      running: healthy,
      reachable: probe.reachable,
      detail: probe.detail,
    });
  }

  const unreachable = statuses.filter((status) => status.running && !status.reachable);
  if (unreachable.length > 0 && remoteEngineNote) {
    warn(
      `${unreachable.map((status) => status.kind).join(", ")} report healthy containers but are not reachable from this machine.`,
    );
    warn(`  ${remoteEngineNote}`);
    warn("  Check the port forwarding between this machine and the engine host.");
  }

  return {
    engine,
    endpoints: endpointsFor(specs, portsByKind, host),
    statuses,
    remoteEngineNote,
  };
}

/**
 * Fixed ports are a feature: connection strings, tunnels, and GUI clients all
 * depend on them. So a conflict is reported with its owner rather than resolved
 * by drifting to another port behind the developer's back.
 */
async function assertPortsAvailable(
  spec: ServiceSpec,
  ports: ResolvedPorts,
  engine: ContainerEngine,
  ourStackIds: string[],
): Promise<void> {
  for (const [role, port] of Object.entries(ports)) {
    const owner = await whoHolds(port, { engine, ourStackIds });

    if (owner.kind === "free" || owner.kind === "our-stack") continue;

    if (owner.kind === "other-compose") {
      conflictError(
        `Cannot start ${spec.kind}: ${describePortOwner(port, owner)}.`,
        `Stop it with:\n  docker compose -p ${owner.project} down\nOr give WorkTrellis a different port:\n  worktrellis services adopt --${spec.kind}-port <port>`,
      );
    }

    conflictError(
      `Cannot start ${spec.kind}: ${describePortOwner(port, owner)}.`,
      `Stop that process, or move WorkTrellis's ${role} port for this machine:\n  worktrellis services adopt --${spec.kind}-port <port>`,
    );
  }
}

export function stackFor(
  engine: ContainerEngine,
  spec: ServiceSpec,
  ports = resolvePorts(spec),
): ComposeStack {
  const legacy = new ComposeStack(engine, renderLegacyStack(spec, ports));
  if (legacy.matchesDefinition()) return legacy;

  return new ComposeStack(engine, renderStack(spec, ports));
}

export function assertKnownService(kind: string, specs: ServiceSpec[]): ServiceSpec {
  const found = specs.find((spec) => spec.kind === kind);
  if (!found) {
    throw new WorkTrellisError(`This project does not declare a "${kind}" service.`, {
      remediation: `Declared services: ${specs.map((spec) => spec.kind).join(", ")}`,
    });
  }
  return found;
}
