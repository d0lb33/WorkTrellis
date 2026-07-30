import fs from "node:fs";
import path from "node:path";

import { WorkTrellisError, EXIT, usageError } from "../core/errors";
import { prepareWorkspace } from "../core/prepare";
import { clearLiveRunState, readLiveRunState } from "../core/state";
import { ensureWorkspaceDatabase } from "../resources/postgres";
import { clearRunRecord, reapOrphans, readRunRecord } from "../supervise/reaper";
import { c, heading, info, success, table, warn } from "../util/log";
import {
  IS_WINDOWS,
  isProcessAlive,
  killTree,
  run as runProcess,
  whichSync,
} from "../util/proc";
import { releasePortlessAlias } from "../url/portless";

export interface CommonOptions {
  cwd?: string;
  configPath?: string;
  json?: boolean;
}

/** Everything read-only shares this: never claim a port, never register a route. */
function peek(options: CommonOptions) {
  return prepareWorkspace({
    cwd: options.cwd,
    configPath: options.configPath,
    startServices: false,
    peekUrl: true,
    writeSnapshotFile: false,
  });
}

// ---------------------------------------------------------------------------
// down
// ---------------------------------------------------------------------------

export async function runDown(options: CommonOptions): Promise<number> {
  const prepared = await peek(options);
  const { context } = prepared;

  const live = readLiveRunState(context.paths.state);
  if (live && isProcessAlive(live.pid) && live.pid !== process.pid) {
    info(`  stopping supervisor ${c.gray(`pid ${live.pid}`)}`);
    killTree(live.pid, "SIGTERM");
  }

  const reaped = reapOrphans(context.paths.run);
  for (const killed of reaped.killed) {
    info(`  stopped ${killed.name} ${c.gray(`pid ${killed.pid}`)}`);
  }
  for (const orphan of reaped.unverified) {
    warn(`pid ${orphan.pid} (${orphan.name}) left alone: ${orphan.reason}`);
  }

  // Release the hostname so the proxy stops routing to a dead port.
  for (const alias of reaped.aliases) {
    await releasePortlessAlias(context.projectRoot, alias);
  }

  clearRunRecord(context.paths.run);
  clearLiveRunState(context.paths.state);

  if (reaped.killed.length === 0 && !live) {
    info("Nothing was running for this worktree.");
  } else {
    success("Stopped.");
  }

  info(c.gray("  Shared services are still up — `pnpm services:down` stops those."));
  return EXIT.ok;
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

export async function runStatus(options: CommonOptions): Promise<number> {
  const prepared = await peek(options);
  const { context, services, url } = prepared;
  const live = readLiveRunState(context.paths.state);
  const running = live !== null && isProcessAlive(live.pid);

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          workspace: context.identity,
          running,
          url: url.url,
          services: services.statuses,
        },
        null,
        2,
      ),
    );
    return EXIT.ok;
  }

  heading(`${context.identity.project}  ${c.cyan(context.identity.slug)}`);
  info("");

  table([
    ["state", running ? c.green(`running (pid ${live?.pid})`) : c.gray("stopped")],
    ["url", running ? c.cyan(url.url.appUrl) : c.gray(`${url.url.appUrl} (when started)`)],
    ["database", context.identity.databaseName],
    ["bucket", context.identity.bucketName],
  ]);

  info("");
  heading("  Services");
  table(
    services.statuses.map((status) => [
      status.kind,
      !status.running
        ? c.red("stopped")
        : status.reachable
          ? c.green("ready")
          : c.yellow("unreachable"),
    ]),
  );

  if (running) {
    const record = liveChildren(context.paths.run);
    if (record.length > 0) {
      info("");
      heading("  Processes");
      table(record.map((child) => [child.name, c.gray(`pid ${child.pid}`)]));
    }
  } else {
    info("");
    info(`  Start it with ${c.cyan("pnpm dev")}.`);
  }

  return EXIT.ok;
}

/** Read the recorded children without killing anything. */
function liveChildren(runFile: string): Array<{ name: string; pid: number }> {
  return (readRunRecord(runFile)?.children ?? [])
    .filter((child) => isProcessAlive(child.pid))
    .map((child) => ({ name: child.name, pid: child.pid }));
}

// ---------------------------------------------------------------------------
// url
// ---------------------------------------------------------------------------

export async function runUrl(
  options: CommonOptions & { tenant?: string },
): Promise<number> {
  const { url } = await peek(options);

  const value = options.tenant
    ? url.url.tenantUrlTemplate.replace("<subdomain>", options.tenant)
    : url.url.appUrl;

  if (options.json) {
    console.log(JSON.stringify({ url: value, mode: url.url.mode }, null, 2));
  } else {
    // Bare, so it can be piped or opened directly.
    process.stdout.write(`${value}\n`);
  }

  return EXIT.ok;
}

// ---------------------------------------------------------------------------
// exec / run
// ---------------------------------------------------------------------------

export async function runExec(
  options: CommonOptions & { argv: string[] },
): Promise<number> {
  if (options.argv.length === 0) {
    usageError(
      "Nothing to run.",
      "Usage: worktrellis exec -- <command> [args...]",
    );
  }

  const prepared = await peek(options);
  const [command, ...args] = options.argv;

  const result = await runProcess(command!, args, {
    cwd: prepared.context.projectRoot,
    env: { ...process.env, ...prepared.env.combined },
  });

  return result.code;
}

export async function runScript(
  options: CommonOptions & { script?: string; argv: string[] },
): Promise<number> {
  if (!options.script) {
    usageError(
      "No script named.",
      "Usage: worktrellis run <package-script> [args...]",
    );
  }

  const prepared = await peek(options);
  const runner = resolvePackageManager(prepared.context.projectRoot);

  const result = await runProcess(
    runner.file,
    [
      ...runner.args,
      "run",
      options.script,
      ...options.argv,
    ],
    {
      cwd: prepared.context.projectRoot,
      env: { ...process.env, ...prepared.env.combined },
    },
  ).catch(() => null);

  if (!result) {
    throw new WorkTrellisError(
      `Could not run ${runner.name} from this project.`,
      {
        remediation: `Use \`worktrellis exec -- <command>\` instead, or run \`${runner.name} run ${options.script}\` directly.`,
      },
    );
  }

  return result.code;
}

export interface PackageManagerCommand {
  file: string;
  args: string[];
  name: string;
}

/**
 * Resolve the project's package manager without assuming it is installed as a
 * dependency. `npm_execpath` is the most reliable source when WorkTrellis itself
 * was launched by a package script; otherwise use the manager declared in
 * package.json and unwrap Corepack's shim to its JavaScript entry on Windows.
 */
export function resolvePackageManager(projectRoot: string): PackageManagerCommand {
  const name = declaredPackageManager(projectRoot);
  const inherited = process.env.npm_execpath;

  if (inherited && fs.existsSync(inherited)) {
    return executablePackageManager(name, inherited);
  }

  const executable = whichSync(name);
  if (!executable) {
    throw new WorkTrellisError(`Could not find the "${name}" package manager.`, {
      remediation: `Install ${name}, enable Corepack, or run the command through \`worktrellis exec --\`.`,
    });
  }

  return executablePackageManager(name, executable);
}

function declaredPackageManager(projectRoot: string): string {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"),
    ) as { packageManager?: string };
    const declared = manifest.packageManager?.split("@")[0]?.trim();
    if (declared) return declared;
  } catch {
    // The config root need not be a JavaScript project. Fall back to the
    // manager that launched WorkTrellis, then pnpm as the CLI's default.
  }

  const fromAgent = process.env.npm_config_user_agent?.split("/")[0]?.trim();
  return fromAgent || "pnpm";
}

function executablePackageManager(
  name: string,
  executable: string,
): PackageManagerCommand {
  let resolved = executable;
  try {
    resolved = fs.realpathSync.native(executable);
  } catch {
    // Keep the original executable; spawn will provide the useful error.
  }

  if (/\.(?:c?js|mjs)$/i.test(resolved)) {
    return { file: process.execPath, args: [resolved], name };
  }

  if (!IS_WINDOWS || /\.(?:exe|com)$/i.test(resolved)) {
    return { file: resolved, args: [], name };
  }

  const directory = path.dirname(executable);
  const knownEntrypoints: Record<string, string[]> = {
    pnpm: [
      path.join(directory, "node_modules", "corepack", "dist", "pnpm.js"),
      path.join(directory, "node_modules", "pnpm", "bin", "pnpm.cjs"),
    ],
    yarn: [
      path.join(directory, "node_modules", "corepack", "dist", "yarn.js"),
    ],
    npm: [
      path.join(directory, "node_modules", "npm", "bin", "npm-cli.js"),
    ],
  };

  const entry = knownEntrypoints[name]?.find((candidate) =>
    fs.existsSync(candidate),
  );
  if (entry) return { file: process.execPath, args: [entry], name };

  throw new WorkTrellisError(
    `Could not safely resolve the "${name}" Windows command shim.`,
    {
      remediation:
        "Enable Corepack or launch WorkTrellis from a package script so npm_execpath identifies the real JavaScript entry point.",
    },
  );
}

// ---------------------------------------------------------------------------
// db
// ---------------------------------------------------------------------------

export async function runDb(
  options: CommonOptions & { subcommand: string | null; seed?: string },
): Promise<number> {
  const prepared = await peek(options);
  const { context, services, env } = prepared;

  const postgres = services.endpoints.postgres;
  if (!postgres) {
    throw new WorkTrellisError("This project does not declare a postgres service.");
  }

  const databaseUrl = postgres.urlFor(context.identity.databaseName);

  switch (options.subcommand) {
    case "url":
      process.stdout.write(`${databaseUrl}\n`);
      return EXIT.ok;

    case "migrate": {
      await ensureWorkspaceDatabase({
        identity: context.identity,
        databaseUrl,
        env: env.combined,
        projectRoot: context.projectRoot,
        hooks: context.config.db,
        migrate: true,
      });
      success("Migrations applied.");
      return EXIT.ok;
    }

    case "seed": {
      await ensureWorkspaceDatabase({
        identity: context.identity,
        databaseUrl,
        env: env.combined,
        projectRoot: context.projectRoot,
        hooks: context.config.db,
        seed: options.seed ?? true,
      });
      success("Seed complete.");
      return EXIT.ok;
    }

    case "reset": {
      const { dropDatabase } = await import("../resources/postgres");
      warn(`Dropping ${context.identity.databaseName} and rebuilding it.`);
      await dropDatabase(databaseUrl, context.identity.databaseName);
      await ensureWorkspaceDatabase({
        identity: context.identity,
        databaseUrl,
        env: env.combined,
        projectRoot: context.projectRoot,
        hooks: context.config.db,
        seed: options.seed,
      });
      success("Database reset.");
      return EXIT.ok;
    }

    default:
      return usageError(
        `Unknown db subcommand "${options.subcommand ?? ""}".`,
        "Try: url, migrate, seed, reset",
      );
  }
}
