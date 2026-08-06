import { buildContext } from "../core/context";
import { EXIT, usageError } from "../core/errors";
import {
  homePaths,
  readMachineConfig,
  writeMachineConfig,
} from "../core/state";
import { c, heading, info, success, table, warn } from "../util/log";
import { assertDaemonRunning, detectEngine } from "../platform/engine";
import {
  clearActiveDockerEndpoint,
  inspectEngineEndpoint,
  isLoopbackAddress,
  isWildcardAddress,
  resolveEngineEndpoint,
  setActiveDockerEndpoint,
  type EngineEndpoint,
} from "../platform/engine-endpoint";
import {
  assertKnownStack,
  ensureInfrastructure,
  stackFor,
  type StackStatus,
} from "../platform/stack";
import {
  listMachineVariants,
  readStackPorts,
  reconcileMachineLineage,
} from "../platform/lineage";
import {
  consumersForProject,
  projectSelection,
} from "../platform/lineage-state";
import { renderStack } from "../platform/compose-render";
import { ComposeStack } from "../platform/compose";

export interface ServicesOptions {
  cwd?: string;
  configPath?: string;
  subcommand: string | null;
  service?: string;
  json?: boolean;
  tail?: number;
  follow?: boolean;
  volumes?: boolean;
  variant?: string;
  from?: string;
  newVariants?: string[];
  portOverrides?: Record<string, number>;
  endpointAction?: string;
  bindAddress?: string;
  connectHost?: string;
}

function renderEndpoint(endpoint: EngineEndpoint): void {
  table([
    ["Docker context", endpoint.contextName ?? "unavailable"],
    ["configuration", endpoint.configured ? "machine override" : "loopback default"],
    ["bind address", endpoint.bindAddress],
    ["connect host", endpoint.connectHost],
  ]);
  if (endpoint.stale) {
    warn("This mapping is stale because the Docker context endpoint changed.");
  } else if (isWildcardAddress(endpoint.bindAddress)) {
    warn(
      `Docker will publish declared service ports on every ${endpoint.bindAddress === "::" ? "IPv6" : "IPv4"} interface. Restrict access with the VM network and firewall.`,
    );
  } else if (!isLoopbackAddress(endpoint.bindAddress)) {
    warn(
      `Docker will publish declared service ports on ${endpoint.bindAddress}. Ensure that address is limited to the development VM network.`,
    );
  }
}

function renderStatuses(statuses: StackStatus[]): void {
  table(
    statuses.map((status) => {
      const ports = Object.entries(status.ports)
        .map(([name, port]) => `${name}:${port}`)
        .join(" ");
      const state = !status.running
        ? c.red("stopped")
        : status.reachable
          ? c.green("ready")
          : c.yellow("unreachable");
      const detail =
        status.running && !status.reachable && status.detail
          ? c.gray(` (${status.detail})`)
          : "";
      return [
        `${status.name} (${status.scope})`,
        `${state}  ${c.gray(ports)}${detail}${
          status.stackId !== status.compatibilityId
            ? c.gray(`  lineage ${status.stackId}`)
            : ""
        }`,
      ];
    }),
  );
}

export async function runServices(options: ServicesOptions): Promise<number> {
  if (options.subcommand === "endpoint") {
    const engine = await detectEngine();
    const action = options.endpointAction ?? "show";
    if (action === "show") {
      heading("Compose service endpoint");
      renderEndpoint(await inspectEngineEndpoint(engine));
      return EXIT.ok;
    }
    if (action === "set") {
      if (!options.bindAddress || !options.connectHost) {
        usageError(
          "`services endpoint set` requires both `--bind-address` and `--connect-host`.",
        );
      }
      await assertDaemonRunning(engine);
      const endpoint = await setActiveDockerEndpoint({
        engine,
        bindAddress: options.bindAddress,
        connectHost: options.connectHost,
      });
      success(`Recorded the endpoint for Docker context ${endpoint.contextName}.`);
      renderEndpoint(endpoint);
      info("");
      info(c.gray(`  Stored in ${homePaths.machineConfig()}.`));
      return EXIT.ok;
    }
    if (action === "clear") {
      const contextName = await clearActiveDockerEndpoint(engine);
      success(`Cleared the endpoint for Docker context ${contextName}.`);
      info("  Declared service ports will use loopback by default.");
      return EXIT.ok;
    }
    usageError(
      `Unknown services endpoint action ${JSON.stringify(action)}.`,
      "Try: worktrellis services endpoint [show|set|clear]",
    );
  }

  const context = await buildContext(options);
  const specs = context.config.compose;
  const baseEnv = Object.freeze(Object.fromEntries(context.baseEnv));

  switch (options.subcommand) {
    case null:
    case "status": {
      const result = await ensureInfrastructure(specs, {
        identity: context.identity,
        projectRoot: context.projectRoot,
        baseEnv,
        startIfStopped: false,
      });
      if (options.json) {
        console.log(JSON.stringify(result.statuses, null, 2));
        return EXIT.ok;
      }

      heading("Compose stacks");
      renderStatuses(result.statuses);
      if (result.endpoint.configured) {
        info("");
        info(
          c.gray(
            `  service endpoint: bind ${result.endpoint.bindAddress}, connect ${result.endpoint.connectHost}`,
          ),
        );
      }
      if (result.remoteEngineNote) {
        info("");
        info(c.gray(`  ${result.remoteEngineNote}`));
      }

      const overrides = readMachineConfig().portOverrides ?? {};
      if (Object.keys(overrides).length > 0) {
        info("");
        info(
          c.gray(
            `  machine port overrides: ${Object.entries(overrides)
              .map(([name, port]) => `${name}=${port}`)
              .join(", ")}`,
          ),
        );
      }
      return EXIT.ok;
    }

    case "up": {
      const result = await ensureInfrastructure(specs, {
        identity: context.identity,
        projectRoot: context.projectRoot,
        baseEnv,
        startIfStopped: true,
        allowNewMachineVariants: options.newVariants,
      });
      heading("Compose stacks");
      renderStatuses(result.statuses);
      const failed = result.statuses.filter((status) => !status.reachable);
      if (failed.length > 0) {
        warn(
          `${failed.map((status) => status.name).join(", ")} did not become reachable.`,
        );
        return EXIT.checkFailed;
      }
      info("");
      success("All Compose stacks ready.");
      return EXIT.ok;
    }

    case "down": {
      const engine = await detectEngine();
      const endpoint = await resolveEngineEndpoint(engine);
      if (options.variant) {
        const spec = specs.find((entry) =>
          options.variant!.startsWith(`worktrellis-machine-${entry.name}-`),
        );
        if (!spec || spec.scope !== "machine") {
          usageError(
            `Unknown machine variant ${JSON.stringify(options.variant)}.`,
            "Use `worktrellis services variants` to list retained variants.",
          );
        }
        const selected = projectSelection(options.variant);
        if (selected) {
          warn(
            `${options.variant} is the selected physical lineage for ${selected.compatibilityId}.`,
          );
          info("Use normal `services down`, or reconcile to another lineage first.");
          return EXIT.conflict;
        }
        const consumers = consumersForProject(options.variant).filter(
          (consumer) => consumer.state !== "stale",
        );
        if (consumers.length > 0) {
          warn(`${options.variant} is still used by ${consumers.map((entry) => entry.slug).join(", ")}.`);
          return EXIT.conflict;
        }
        const desired = renderStack({
          spec,
          projectRoot: context.projectRoot,
          identity: context.identity,
          baseEnv,
          bindAddress: endpoint.bindAddress,
        });
        if (!/^[a-z0-9][a-z0-9_-]*$/.test(options.variant)) {
          usageError(`Invalid Compose project name ${JSON.stringify(options.variant)}.`);
        }
        const known = (
          await listMachineVariants({ engine, rendered: desired })
        ).some((entry) => entry.projectName === options.variant);
        if (!known) {
          usageError(
            `Unknown retained variant ${JSON.stringify(options.variant)}.`,
            "Use `worktrellis services variants` to list retained variants.",
          );
        }
        const rendered = renderStack({
          spec,
          projectRoot: context.projectRoot,
          identity: context.identity,
          baseEnv,
          bindAddress: endpoint.bindAddress,
          physicalProjectName: options.variant,
          physicalPorts: readStackPorts(options.variant, desired.portSpecs),
        });
        info(`  stopping ${c.cyan(options.variant)}`);
        await new ComposeStack(engine, rendered).down({ volumes: options.volumes });
        success(
          options.volumes
            ? "Variant stopped and its data volumes removed."
            : "Variant stopped. Data volumes kept.",
        );
        return EXIT.ok;
      }
      for (const spec of specs) {
        const stack = stackFor(
          engine,
          spec,
          context.projectRoot,
          context.identity,
          baseEnv,
          endpoint.bindAddress,
        );
        info(`  stopping ${c.cyan(stack.rendered.stackId)}`);
        await stack.down({ volumes: options.volumes });
      }
      success(
        options.volumes
          ? "Compose stacks stopped and their data volumes removed."
          : "Compose stacks stopped. Data volumes kept.",
      );
      return EXIT.ok;
    }

    case "variants": {
      const engine = await detectEngine();
      const endpoint = await resolveEngineEndpoint(engine);
      const selectedSpecs = options.service
        ? specs.filter((spec) => spec.name === options.service)
        : specs.filter((spec) => spec.scope === "machine");
      if (options.service && selectedSpecs.length === 0) {
        usageError(`This project does not declare machine stack "${options.service}".`);
      }
      const results = [];
      for (const spec of selectedSpecs) {
        const stack = stackFor(
          engine,
          spec,
          context.projectRoot,
          context.identity,
          baseEnv,
          endpoint.bindAddress,
        );
        results.push({
          stack: spec.name,
          compatibilityId: stack.rendered.compatibilityId,
          projectName: stack.rendered.stackId,
          variants: await listMachineVariants({ engine, rendered: stack.rendered }),
        });
      }
      if (options.json) {
        console.log(JSON.stringify(results, null, 2));
        return EXIT.ok;
      }
      for (const result of results) {
        heading(`${result.stack} variants`);
        if (result.variants.length === 0) {
          info(c.gray("  none"));
          continue;
        }
        table(
          result.variants.map((variant) => [
            `${variant.selected ? "* " : "  "}${variant.projectName}`,
            `${variant.running ? "running" : "stopped"}  ${variant.volumes.length} volume(s)  ${variant.compatibility}`,
          ]),
        );
        for (const variant of result.variants) {
          for (const consumer of variant.consumers) {
            info(
              c.gray(
                `    ${variant.projectName}: ${consumer.project}/${consumer.slug} pid ${consumer.pid} ${consumer.state}`,
              ),
            );
          }
        }
      }
      return EXIT.ok;
    }

    case "reconcile": {
      const name = options.service;
      if (!name) {
        usageError(
          "A stack name is required.",
          "Example: worktrellis services reconcile infrastructure --from worktrellis-machine-infrastructure-deadbeef",
        );
      }
      if (!options.from) usageError("`services reconcile` requires `--from <compose-project>`. ");
      const spec = specs.find((entry) => entry.name === name);
      if (!spec) usageError(`This project does not declare stack "${name}".`);
      const engine = await detectEngine();
      const endpoint = await resolveEngineEndpoint(engine);
      const rendered = await reconcileMachineLineage({
        engine,
        spec,
        projectRoot: context.projectRoot,
        identity: context.identity,
        baseEnv,
        sourceProject: options.from,
        bindAddress: endpoint.bindAddress,
      });
      success(`Selected ${rendered.stackId} for ${rendered.compatibilityId}.`);
      return EXIT.ok;
    }

    case "restart": {
      const engine = await detectEngine();
      const endpoint = await resolveEngineEndpoint(engine);
      for (const spec of specs) {
        const stack = stackFor(
          engine,
          spec,
          context.projectRoot,
          context.identity,
          baseEnv,
          endpoint.bindAddress,
        );
        info(`  restarting ${c.cyan(stack.rendered.stackId)}`);
        await stack.down();
      }
      const result = await ensureInfrastructure(specs, {
        identity: context.identity,
        projectRoot: context.projectRoot,
        baseEnv,
        startIfStopped: true,
        allowNewMachineVariants: options.newVariants,
      });
      renderStatuses(result.statuses);
      return result.statuses.every((status) => status.reachable)
        ? EXIT.ok
        : EXIT.checkFailed;
    }

    case "logs": {
      const engine = await detectEngine();
      const endpoint = await resolveEngineEndpoint(engine);
      const stacks = specs.map((spec) => ({
        spec,
        stack: stackFor(
          engine,
          spec,
          context.projectRoot,
          context.identity,
          baseEnv,
          endpoint.bindAddress,
        ),
      }));
      const selected = options.service
        ? assertKnownStack(options.service, stacks)
        : stacks[0];
      if (!selected) usageError("This project declares no Compose stacks.");
      return (await selected.stack.logs({
        tail: options.tail,
        follow: options.follow,
      })) === 0
        ? EXIT.ok
        : EXIT.checkFailed;
    }

    case "adopt": {
      const overrides = options.portOverrides ?? {};
      if (Object.keys(overrides).length === 0) {
        usageError(
          "No port overrides supplied.",
          "Example: worktrellis services adopt --database-port 5433",
        );
      }

      const machine = readMachineConfig();
      machine.portOverrides = { ...machine.portOverrides, ...overrides };
      writeMachineConfig(machine);

      success("Recorded machine-local port overrides:");
      table(
        Object.entries(overrides).map(([name, port]) => [name, String(port)]),
      );
      info("");
      info(c.gray(`  Stored in ${homePaths.machineConfig()}.`));
      info(`  Apply them with ${c.cyan("worktrellis services restart")}.`);
      return EXIT.ok;
    }

    default:
      return usageError(
        `Unknown services subcommand "${options.subcommand}".`,
        "Try: up, down, restart, status, logs, variants, reconcile, adopt, endpoint",
      );
  }
}
