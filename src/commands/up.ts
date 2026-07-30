import path from "node:path";

import { EXIT } from "../core/errors";
import { prepareWorkspace } from "../core/prepare";
import { ensureWorkspaceDatabase } from "../resources/postgres";
import { describeResources, provisionResources } from "../resources";
import { clearLiveRunState, writeLiveRunState } from "../core/state";
import { reapOrphans } from "../supervise/reaper";
import { installSignalHandlers } from "../supervise/signals";
import { Supervisor } from "../supervise/supervisor";
import { clearRunRecord } from "../supervise/reaper";
import { c, heading, info, step, table, warn } from "../util/log";
import type { UrlPreference } from "../url/provider";
import type { PostgresDatabase } from "../types";

export interface UpOptions {
  cwd?: string;
  configPath?: string;
  only?: string[];
  services?: boolean;
  urlPreference?: UrlPreference;
  migrate?: boolean;
  seed?: string | boolean;
  prefix?: boolean;
  raw?: string;
}

export async function runUp(options: UpOptions): Promise<number> {
  // Clear leftovers from a previous run before anything tries to bind a port.
  const prepared = await prepareWorkspace({
    cwd: options.cwd,
    configPath: options.configPath,
    startServices: options.services !== false,
    urlPreference: options.urlPreference,
  });

  const { context, infrastructure, url, env, envContext } = prepared;
  const { identity } = context;

  info("");
  heading(`${identity.project}  ${c.cyan(identity.slug)}`);
  info(
    c.gray(
      `  ${identity.branch ?? "detached HEAD"} · ${identity.isLinkedWorktree ? "linked worktree" : "main checkout"}`,
    ),
  );
  info("");

  const reaped = reapOrphans(context.paths.run);
  if (reaped.killed.length > 0) {
    step(
      "reaping",
      `stopped ${reaped.killed.length} leftover process(es) from a previous run`,
    );
  }
  for (const orphan of reaped.unverified) {
    warn(
      `pid ${orphan.pid} (${orphan.name}) from a previous run is still alive but ${orphan.reason}; leaving it alone.`,
    );
  }

  // Services
  const unreachable = infrastructure.statuses.filter(
    (status) => !status.reachable,
  );
  if (unreachable.length > 0) {
    warn(
      `${unreachable.map((status) => status.name).join(", ")} not reachable. The app will start but will fail when it tries to use them.`,
    );
  } else {
    step(
      "services",
      infrastructure.statuses
        .map((status) => `${status.name} ${c.green("ready")}`)
        .join("  "),
    );
  }

  // Critical env conflicts are worth interrupting for: they mean this workspace
  // is not actually isolated from another one.
  const critical = env.conflicts.filter((conflict) => conflict.severity === "critical");
  if (critical.length > 0) {
    warn(
      `${critical.length} key(s) in ${path.basename(context.baseEnvPath)} conflict with WorkTrellis-managed values (${critical
        .map((conflict) => conflict.key)
        .join(", ")}). WorkTrellis values are in use; run \`worktrellis env --explain\` for detail.`,
    );
  }

  // Database. The URL is computed from the resolved endpoint rather than read
  // out of the environment, so WorkTrellis never has to assume what a project
  // calls its connection-string variable.
  try {
    await provisionResources({
      adapters: context.config.resources,
      resources: envContext.resources,
      compose: envContext.compose,
      identity,
      projectRoot: context.projectRoot,
      baseEnv: envContext.baseEnv,
      skip: context.config.db ? [context.config.db.resource] : undefined,
    });
  } catch (caught) {
    warn(`resource provisioning failed: ${(caught as Error).message}`);
  }

  if (context.config.db) {
    const postgres = envContext.resources[
      context.config.db.resource
    ] as PostgresDatabase;
    try {
      const result = await ensureWorkspaceDatabase({
        identity,
        databaseUrl: postgres.url,
        env: env.combined,
        projectRoot: context.projectRoot,
        hooks: context.config.db,
        migrate: options.migrate,
        seed: options.seed,
      });

      step(
        "database",
        `${postgres.database} ${c.green(
          result.created ? "created" : "ready",
        )}${result.migrated ? c.gray(" · migrated") : ""}${result.seeded ? c.gray(" · seeded") : ""}`,
      );
    } catch (caught) {
      // A database problem should not be silently fatal to `up`; report it and
      // let the developer decide, since the app may still be worth starting.
      warn(`database provisioning failed: ${(caught as Error).message}`);
    }
  }

  // URL
  step(
    "url",
    `${url.url.mode}  ${c.cyan(url.url.appUrl)} ${c.gray(`-> 127.0.0.1:${url.url.listenPort}`)}`,
  );
  if (url.url.fallbackReason) {
    info(c.gray(`            using a plain localhost port because ${url.url.fallbackReason}`));
  }

  // Processes
  const selected = options.only
    ? context.config.processes.filter((spec) => options.only!.includes(spec.name))
    : context.config.processes;

  if (selected.length === 0) {
    info("");
    info("Nothing to run.");
    await url.release();
    return EXIT.ok;
  }

  info("");
  const resourceRows = describeResources(
    context.config.resources,
    envContext.resources,
  ).map(
    (resource) =>
      [
        resource.name,
        c.gray(resource.detail),
      ] as [string, string],
  );
  table([
    ["App", c.cyan(url.url.appUrl)],
    ["Tenants", c.gray(url.url.tenantUrlTemplate)],
    ...resourceRows,
  ]);
  info("");

  const supervisor = new Supervisor({
    projectRoot: context.projectRoot,
    env: env.combined,
    envContext: prepared.envContext,
    runFile: context.paths.run,
    logDirectory: context.paths.logs,
    identity: {
      project: identity.project,
      slug: identity.slug,
      root: identity.root,
    },
    aliases: url.aliasName ? [url.aliasName] : [],
    prefix: options.prefix,
    raw: options.raw,
  });

  selected.forEach((spec, index) => supervisor.add(spec, index));

  // Record what we claimed, so read-only commands report the live URL instead
  // of deriving (and re-registering) one of their own.
  writeLiveRunState(context.paths.state, {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    url: url.url,
  });

  const uninstall = installSignalHandlers(supervisor, async () => {
    clearLiveRunState(context.paths.state);
    await url.release();
  });

  info(c.gray("  Ctrl+C to stop everything."));
  info("");

  const code = await supervisor.run();

  uninstall();
  clearRunRecord(context.paths.run);
  clearLiveRunState(context.paths.state);
  await url.release();

  return code === 0 ? EXIT.ok : EXIT.child;
}
