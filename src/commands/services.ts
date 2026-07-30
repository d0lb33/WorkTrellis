import { buildContext } from "../core/context";
import { EXIT, usageError } from "../core/errors";
import {
  homePaths,
  readMachineConfig,
  writeMachineConfig,
} from "../core/state";
import { c, heading, info, success, table, warn } from "../util/log";
import { detectEngine } from "../platform/engine";
import {
  assertKnownStack,
  ensureInfrastructure,
  stackFor,
  type StackStatus,
} from "../platform/stack";

export interface ServicesOptions {
  cwd?: string;
  configPath?: string;
  subcommand: string | null;
  service?: string;
  json?: boolean;
  tail?: number;
  follow?: boolean;
  volumes?: boolean;
  portOverrides?: Record<string, number>;
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
        `${state}  ${c.gray(ports)}${detail}`,
      ];
    }),
  );
}

export async function runServices(options: ServicesOptions): Promise<number> {
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
      for (const spec of specs) {
        const stack = stackFor(
          engine,
          spec,
          context.projectRoot,
          context.identity,
          baseEnv,
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

    case "restart": {
      const engine = await detectEngine();
      for (const spec of specs) {
        const stack = stackFor(
          engine,
          spec,
          context.projectRoot,
          context.identity,
          baseEnv,
        );
        info(`  restarting ${c.cyan(stack.rendered.stackId)}`);
        await stack.down();
      }
      const result = await ensureInfrastructure(specs, {
        identity: context.identity,
        projectRoot: context.projectRoot,
        baseEnv,
        startIfStopped: true,
      });
      renderStatuses(result.statuses);
      return result.statuses.every((status) => status.reachable)
        ? EXIT.ok
        : EXIT.checkFailed;
    }

    case "logs": {
      const engine = await detectEngine();
      const stacks = specs.map((spec) => ({
        spec,
        stack: stackFor(
          engine,
          spec,
          context.projectRoot,
          context.identity,
          baseEnv,
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
        "Try: up, down, restart, status, logs, adopt",
      );
  }
}
