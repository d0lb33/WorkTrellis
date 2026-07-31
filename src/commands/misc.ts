import fs from "node:fs";
import path from "node:path";

import { WorkTrellisError, EXIT, usageError } from "../core/errors";
import { prepareWorkspace } from "../core/prepare";
import {
  clearLiveRunState,
  readLiveRunState,
  writeLiveRunState,
} from "../core/state";
import { ensureWorkspaceDatabase } from "../resources/postgres";
import { describeResources } from "../resources";
import type {
  PostgresDatabase,
  ResourceAdapters,
  UrlContext,
  WorkspaceIdentity,
} from "../types";
import type { StackStatus } from "../platform/stack";
import {
  clearRunRecord,
  reapOrphans,
  readRunRecord,
  writeRunRecord,
} from "../supervise/reaper";
import { c, heading, info, success, table, warn } from "../util/log";
import {
  IS_WINDOWS,
  isProcessAlive,
  killTree,
  run as runProcess,
  whichSync,
} from "../util/proc";
import { releasePortlessAlias } from "../url/portless";
import { canConnect, waitForPortClose } from "../platform/ports";
import {
  clearShutdownRequest,
  requestGracefulShutdown,
  verifySupervisorForShutdown,
  waitForProcessExit,
} from "../supervise/shutdown";
import { redactDiagnosticText } from "../core/env-resolve";

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
  const originalRecord = readRunRecord(context.paths.run);
  const supervisorPid = live?.pid ?? originalRecord?.supervisorPid;
  const hadRun = live !== null || originalRecord !== null;

  if (
    supervisorPid &&
    isProcessAlive(supervisorPid) &&
    supervisorPid !== process.pid
  ) {
    const verification = verifySupervisorForShutdown(originalRecord, {
      pid: supervisorPid,
      startedAt: live?.startedAt,
      project: context.identity.project,
      slug: context.identity.slug,
      worktreeRoot: context.identity.root,
    });

    if (!verification.verified) {
      warn(
        `supervisor pid ${supervisorPid} left alone: ${verification.reason ?? "could not verify ownership"}`,
      );
      return EXIT.checkFailed;
    }

    info(`  requesting graceful shutdown ${c.gray(`pid ${supervisorPid}`)}`);
    requestGracefulShutdown(context.paths.stop, originalRecord!);

    const graceful = await waitForProcessExit(supervisorPid);
    if (!graceful) {
      warn(
        `supervisor pid ${supervisorPid} did not stop gracefully; forcing shutdown`,
      );
      killTree(supervisorPid, "SIGKILL");
      await waitForProcessExit(supervisorPid, { timeoutMs: 2_000 });
    }
  }

  const reaped = await reapOrphans(context.paths.run, { clearRecord: false });
  for (const stopped of reaped.stopped) {
    info(
      `  ${stopped.forced ? "force-stopped" : "stopped"} ${stopped.name} ${c.gray(`pid ${stopped.pid}`)}`,
    );
  }
  for (const orphan of reaped.blocked) {
    warn(`pid ${orphan.pid} (${orphan.name}) left alone: ${orphan.reason}`);
  }

  // Remove static aliases recorded by older WorkTrellis releases.
  for (const alias of reaped.aliases) {
    await releasePortlessAlias(context.projectRoot, alias);
  }

  const remainingSupervisor =
    supervisorPid !== undefined && isProcessAlive(supervisorPid);
  const remainingChildren = (originalRecord?.children ?? []).filter((child) =>
    isProcessAlive(child.pid),
  );
  const appPortStillListening = live
    ? !(await waitForPortClose(live.url.listenPort, {
        host: live.url.listenHost || "127.0.0.1",
        timeoutMs: 2_000,
      }))
    : false;
  const incomplete =
    remainingSupervisor ||
    remainingChildren.length > 0 ||
    reaped.blocked.length > 0 ||
    appPortStillListening;

  if (incomplete) {
    if (originalRecord && !readRunRecord(context.paths.run)) {
      writeRunRecord(context.paths.run, originalRecord);
    }
    if (live && !readLiveRunState(context.paths.state)) {
      writeLiveRunState(context.paths.state, live);
    }
    if (remainingSupervisor) {
      warn(`supervisor pid ${supervisorPid} is still running`);
    }
    for (const child of remainingChildren) {
      warn(`managed process ${child.name} is still running as pid ${child.pid}`);
    }
    if (appPortStillListening && live) {
      warn(`application port ${live.url.listenPort} is still accepting connections`);
    }
    warn("Shutdown is incomplete; run state was retained for diagnosis.");
    return EXIT.checkFailed;
  }

  clearRunRecord(context.paths.run);
  clearLiveRunState(context.paths.state);
  clearShutdownRequest(context.paths.stop);

  if (!hadRun) {
    info("Nothing was running for this worktree.");
  } else {
    success("Stopped.");
  }

  info(c.gray("  Compose stacks are still up — `worktrellis services down` stops those."));
  return EXIT.ok;
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

export async function runStatus(options: CommonOptions): Promise<number> {
  const prepared = await peek(options);
  const { context, infrastructure, url, envContext, env } = prepared;
  const live = readLiveRunState(context.paths.state);
  const children = liveChildren(context.paths.run);
  const supervisorAlive = live !== null && isProcessAlive(live.pid);
  const portListening = live
    ? await canConnect(
        live.url.listenPort,
        live.url.listenHost || "127.0.0.1",
        250,
      )
    : false;
  const runtimeState = classifyRuntimeState({
    supervisorAlive,
    liveChildCount: children.length,
    portListening,
  });
  const running = runtimeState === "running";
  const orphaned = runtimeState === "orphaned";

  if (options.json) {
    console.log(
      JSON.stringify(
        buildStatusJson({
          workspace: context.identity,
          running,
          orphaned,
          state: runtimeState,
          url: url.url,
          compose: infrastructure.statuses,
          resourceAdapters: context.config.resources,
          resources: envContext.resources,
          diagnosticSources: [env.combined],
        }),
        null,
        2,
      ),
    );
    return orphaned ? EXIT.checkFailed : EXIT.ok;
  }

  heading(`${context.identity.project}  ${c.cyan(context.identity.slug)}`);
  info("");

  table([
    [
      "state",
      running
        ? c.green(`running (pid ${live?.pid})`)
        : orphaned
          ? c.yellow("orphaned processes detected")
          : c.gray("stopped"),
    ],
    [
      "url",
      running || orphaned
        ? c.cyan(url.url.appUrl)
        : c.gray(`${url.url.appUrl} (when started)`),
    ],
    ...describeResources(
      context.config.resources,
      envContext.resources,
    ).map(
      (resource) =>
        [
          resource.name,
          redactDiagnosticText(
            resource.detail,
            env.combined,
            envContext.resources,
          ),
        ] as [string, string],
    ),
  ]);

  info("");
  heading("  Compose");
  table(
    infrastructure.statuses.map((status) => [
      `${status.name} (${status.scope})`,
      !status.running
        ? c.red("stopped")
        : status.reachable
          ? c.green("ready")
          : c.yellow("unreachable"),
    ]),
  );

  if (running || orphaned) {
    if (children.length > 0) {
      info("");
      heading("  Processes");
      table(children.map((child) => [child.name, c.gray(`pid ${child.pid}`)]));
    }
    if (orphaned) {
      info("");
      warn("Run `worktrellis down` to clean up this workspace before restarting.");
    }
  } else {
    info("");
    info(`  Start it with ${c.cyan("pnpm dev")}.`);
  }

  return orphaned ? EXIT.checkFailed : EXIT.ok;
}

export function buildStatusJson(input: {
  workspace: WorkspaceIdentity;
  running: boolean;
  orphaned: boolean;
  state: RuntimeState;
  url: UrlContext;
  compose: StackStatus[];
  resourceAdapters?: ResourceAdapters;
  resources: Record<string, unknown>;
  diagnosticSources?: unknown[];
}) {
  const diagnosticSources = [
    input.resources,
    ...(input.diagnosticSources ?? []),
  ];
  const workspace = {
    repoKey: input.workspace.repoKey,
    isLinkedWorktree: input.workspace.isLinkedWorktree,
    branch: input.workspace.branch,
    head: input.workspace.head,
    project: input.workspace.project,
    slug: input.workspace.slug,
    fingerprint: input.workspace.fingerprint,
    ports: input.workspace.ports,
  };
  const url = {
    mode: input.url.mode,
    appUrl: input.url.appUrl,
    rootDomain: input.url.rootDomain,
    cookieDomain: input.url.cookieDomain,
    tenantUrlTemplate: input.url.tenantUrlTemplate,
    wildcardOrigins: input.url.wildcardOrigins,
    listenHost: input.url.listenHost,
    listenPort: input.url.listenPort,
    ...(input.url.fallbackReason
      ? {
          fallbackReason: redactDiagnosticText(
            input.url.fallbackReason,
            ...diagnosticSources,
          ),
        }
      : {}),
  };
  const resources = describeResources(
    input.resourceAdapters,
    input.resources,
  ).map((resource) => ({
    ...resource,
    detail: redactDiagnosticText(resource.detail, ...diagnosticSources),
  }));
  const compose = input.compose.map((status) => ({
    ...status,
    ...(typeof status.detail === "string"
      ? {
          detail: redactDiagnosticText(status.detail, ...diagnosticSources),
        }
      : {}),
  }));

  return {
    workspace,
    running: input.running,
    orphaned: input.orphaned,
    state: input.state,
    url,
    compose,
    resources,
  };
}

export type RuntimeState = "running" | "orphaned" | "stopped";

export function classifyRuntimeState(input: {
  supervisorAlive: boolean;
  liveChildCount: number;
  portListening: boolean;
}): RuntimeState {
  if (input.supervisorAlive) return "running";
  if (input.liveChildCount > 0 || input.portListening) return "orphaned";
  return "stopped";
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
  const { context, env, envContext } = prepared;

  const resourceName = context.config.db?.resource;
  if (!resourceName) {
    throw new WorkTrellisError(
      "This project does not configure database commands.",
      {
        remediation:
          "Add `db: { resource: \"<postgres-resource-name>\", ... }` to worktrellis.config.ts.",
      },
    );
  }
  const postgres = envContext.resources[resourceName] as PostgresDatabase;

  const databaseUrl = postgres.url;

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
      warn(`Dropping ${postgres.database} and rebuilding it.`);
      await dropDatabase(databaseUrl, postgres.database);
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
