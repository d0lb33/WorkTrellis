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
  assertKnownService,
  ensureServices,
  resolvePorts,
  stackFor,
  type ServiceStatus,
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

function renderStatuses(statuses: ServiceStatus[]): void {
  const rows: Array<[string, string]> = statuses.map((status) => {
    const ports = Object.entries(status.ports)
      .map(([role, port]) => (role === "main" ? String(port) : `${role}:${port}`))
      .join(" ");

    const state = !status.running
      ? c.red("stopped")
      : status.reachable
        ? c.green("ready")
        : c.yellow("unreachable");

    const detail = status.running && !status.reachable && status.detail
      ? c.gray(`  (${status.detail})`)
      : "";

    return [status.kind, `${state}  ${c.gray(ports)}${detail}`];
  });

  table(rows);
}

export async function runServices(options: ServicesOptions): Promise<number> {
  const context = await buildContext(options);
  const specs = context.config.services;

  switch (options.subcommand) {
    case null:
    case "status": {
      const result = await ensureServices(specs, { startIfStopped: false });

      if (options.json) {
        console.log(JSON.stringify(result.statuses, null, 2));
        return EXIT.ok;
      }

      heading("Shared services");
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
              .map(([kind, port]) => `${kind}=${port}`)
              .join(", ")}`,
          ),
        );
      }

      const down = result.statuses.filter((status) => !status.running);
      if (down.length > 0) {
        info("");
        info(`  Start them with ${c.cyan("pnpm services:up")}.`);
      }

      return EXIT.ok;
    }

    case "up": {
      const result = await ensureServices(specs, { startIfStopped: true });
      info("");
      heading("Shared services");
      renderStatuses(result.statuses);

      const failed = result.statuses.filter((status) => !status.reachable);
      if (failed.length > 0) {
        info("");
        warn(
          `${failed.map((status) => status.kind).join(", ")} did not become reachable.`,
        );
        return EXIT.checkFailed;
      }

      info("");
      success("All services ready.");
      return EXIT.ok;
    }

    case "down": {
      const engine = await detectEngine();
      for (const spec of specs) {
        const stack = stackFor(engine, spec);
        info(`  stopping ${c.cyan(stack.rendered.stackId)}`);
        await stack.down({ volumes: options.volumes });
      }
      success(
        options.volumes
          ? "Services stopped and their data volumes removed."
          : "Services stopped. Data volumes kept.",
      );
      return EXIT.ok;
    }

    case "restart": {
      const engine = await detectEngine();
      for (const spec of specs) {
        const stack = stackFor(engine, spec);
        info(`  restarting ${c.cyan(stack.rendered.stackId)}`);
        await stack.down();
      }
      const result = await ensureServices(specs, { startIfStopped: true });
      info("");
      renderStatuses(result.statuses);
      return EXIT.ok;
    }

    case "logs": {
      const engine = await detectEngine();
      const spec = options.service
        ? assertKnownService(options.service, specs)
        : specs[0];
      if (!spec) usageError("This project declares no services.");

      const stack = stackFor(engine, spec);
      return (await stack.logs({ tail: options.tail, follow: options.follow })) === 0
        ? EXIT.ok
        : EXIT.checkFailed;
    }

    case "adopt": {
      const overrides = options.portOverrides ?? {};
      if (Object.keys(overrides).length === 0) {
        usageError(
          "No port overrides supplied.",
          "Example: worktrellis services adopt --postgres-port 5433",
        );
      }

      const config = readMachineConfig();
      config.portOverrides = { ...config.portOverrides, ...overrides };
      writeMachineConfig(config);

      success("Recorded machine-local port overrides:");
      table(
        Object.entries(overrides).map(([kind, port]) => [kind, String(port)]),
      );
      info("");
      info(
        c.gray(
          `  These live in ${homePaths.machineConfig()} and are never committed.`,
        ),
      );
      info(`  Apply them with ${c.cyan("pnpm services:restart")}.`);

      // Show the effective ports so the new values are never a mystery.
      info("");
      heading("Effective ports");
      table(
        specs.map((spec) => [
          spec.kind,
          Object.entries(resolvePorts(spec))
            .map(([role, port]) => (role === "main" ? String(port) : `${role}:${port}`))
            .join(" "),
        ]),
      );

      return EXIT.ok;
    }

    default:
      return usageError(
        `Unknown services subcommand "${options.subcommand}".`,
        "Try: up, down, restart, status, logs, adopt",
      );
  }
}
