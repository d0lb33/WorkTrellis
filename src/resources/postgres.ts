import fs from "node:fs";
import path from "node:path";

import type { BootstrapContext, BootstrapHooks, WorkspaceIdentity } from "../types";
import { WorkTrellisError, environmentError } from "../core/errors";
import { c, step } from "../util/log";
import { run } from "../util/proc";

/**
 * Per-workspace database provisioning.
 *
 * Isolation is per DATABASE, never per schema: change-notification channels in
 * Postgres are database-scoped, so two workspaces sharing a database with
 * different schemas would still receive each other's notifications.
 */

interface PgClient {
  query<T = unknown>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  end(): Promise<void>;
}

/**
 * `pg` is a WorkTrellis dependency so database provisioning works without
 * requiring every host project to install its own copy.
 */
async function loadPgClient(): Promise<new (config: { connectionString: string }) => PgClient> {
  try {
    const imported = (await import("pg")) as unknown as {
      default?: { Client: new (config: { connectionString: string }) => PgClient };
      Client?: new (config: { connectionString: string }) => PgClient;
    };
    const Client = imported.Client ?? imported.default?.Client;
    if (!Client) throw new Error("the pg module exposes no Client export");
    return Client;
  } catch (caught) {
    return environmentError(
      "Could not load the `pg` driver, which WorkTrellis needs to provision databases.",
      `Reinstall WorkTrellis and try again.\n${(caught as Error).message}`,
    );
  }
}

async function connect(connectionString: string): Promise<PgClient> {
  const Client = await loadPgClient();
  const client = new Client({ connectionString });
  await (client as unknown as { connect(): Promise<void> }).connect();
  return client;
}

function adminUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.pathname = "/postgres";
  url.search = "";
  return url.toString();
}

function databaseNameOf(databaseUrl: string): string {
  return decodeURIComponent(new URL(databaseUrl).pathname).replace(/^\//, "");
}

/** Postgres identifier quoting: double the quotes, wrap in quotes. */
function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Resolve an installed package's executable to its real JavaScript entry point,
 * read from that package's own manifest.
 *
 * Spawning the entry directly with this Node binary avoids the `.cmd` shims,
 * which Node refuses to launch without a shell — and a shell would reintroduce
 * argument-escaping differences between platforms.
 */
function resolvePackageBin(projectRoot: string, name: string): string {
  const manifestPath = path.join(projectRoot, "node_modules", name, "package.json");

  let manifest: { bin?: string | Record<string, string>; main?: string };
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as typeof manifest;
  } catch {
    throw new WorkTrellisError(`Could not find the "${name}" package in this project.`, {
      remediation: `Install it, or point the hook at an explicit path instead of bin("${name}").`,
    });
  }

  const entry =
    typeof manifest.bin === "string"
      ? manifest.bin
      : (manifest.bin?.[name] ?? Object.values(manifest.bin ?? {})[0] ?? manifest.main);

  if (!entry) {
    throw new WorkTrellisError(`The "${name}" package declares no executable.`);
  }

  return path.join(projectRoot, "node_modules", name, entry);
}

export async function databaseExists(
  databaseUrl: string,
  name: string,
): Promise<boolean> {
  const admin = await connect(adminUrl(databaseUrl));
  try {
    const result = await admin.query<{ one: number }>(
      "select 1 as one from pg_database where datname = $1",
      [name],
    );
    return result.rows.length > 0;
  } finally {
    await admin.end();
  }
}

export async function createDatabase(
  databaseUrl: string,
  name: string,
): Promise<void> {
  const admin = await connect(adminUrl(databaseUrl));
  try {
    // Serialize concurrent provisioning: two worktrees may start together, and
    // CREATE DATABASE is not idempotent.
    await admin.query("select pg_advisory_lock(hashtextextended($1, 0))", [
      `worktrellis:create:${name}`,
    ]);

    const existing = await admin.query(
      "select 1 from pg_database where datname = $1",
      [name],
    );

    if (existing.rows.length === 0) {
      await admin.query(`create database ${quoteIdentifier(name)}`);
    }

    await admin.query("select pg_advisory_unlock(hashtextextended($1, 0))", [
      `worktrellis:create:${name}`,
    ]);
  } finally {
    await admin.end();
  }
}

export async function dropDatabase(
  databaseUrl: string,
  name: string,
): Promise<void> {
  const admin = await connect(adminUrl(databaseUrl));
  try {
    // Existing connections block a drop, so close them first.
    await admin.query(
      "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
      [name],
    );
    await admin.query(`drop database if exists ${quoteIdentifier(name)}`);
  } finally {
    await admin.end();
  }
}

/** Marks a database as WorkTrellis-managed and records where it came from. */
const PROVENANCE_DDL = `
create table if not exists _worktrellis_workspace (
  slug text primary key,
  project text not null,
  worktree_path text not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
)`;

/**
 * True once a database has completed setup. Used to distinguish "this database
 * exists" from "this database is usable".
 */
async function hasProvenance(databaseUrl: string): Promise<boolean> {
  const client = await connect(databaseUrl);
  try {
    const result = await client.query<{ exists: boolean }>(
      "select to_regclass('public._worktrellis_workspace') is not null as exists",
    );
    return result.rows[0]?.exists === true;
  } catch {
    return false;
  } finally {
    await client.end();
  }
}

async function recordProvenance(
  databaseUrl: string,
  identity: WorkspaceIdentity,
): Promise<void> {
  const client = await connect(databaseUrl);
  try {
    await client.query(PROVENANCE_DDL);
    await client.query(
      `insert into _worktrellis_workspace (slug, project, worktree_path)
       values ($1, $2, $3)
       on conflict (slug) do update set last_seen_at = now(), worktree_path = excluded.worktree_path`,
      [identity.slug, identity.project, identity.root],
    );
  } finally {
    await client.end();
  }
}

function buildBootstrapContext(options: {
  identity: WorkspaceIdentity;
  env: Record<string, string>;
  databaseUrl: string;
  projectRoot: string;
}): BootstrapContext {
  return {
    workspace: options.identity,
    env: options.env,
    databaseUrl: options.databaseUrl,

    async exec(bin, args, execOptions) {
      const result = await run(process.execPath, [bin, ...args], {
        cwd: options.projectRoot,
        env: { ...process.env, ...options.env, ...execOptions?.env },
        capture: true,
        timeoutMs: 600_000,
      });

      if (result.code !== 0) {
        throw new WorkTrellisError(
          `${path.basename(bin)} ${args.join(" ")} failed (exit ${result.code}).`,
          {
            remediation: [result.stdout, result.stderr]
              .join("\n")
              .trim()
              .split("\n")
              .slice(-12)
              .join("\n"),
          },
        );
      }
    },

    bin: (name) => resolvePackageBin(options.projectRoot, name),

    async sql<T = unknown>(text: string, params?: unknown[]): Promise<T[]> {
      const client = await connect(options.databaseUrl);
      try {
        const result = await client.query<T>(text, params);
        return result.rows;
      } finally {
        await client.end();
      }
    },

    log(message) {
      step("database", message);
    },
  };
}

export interface EnsureDatabaseResult {
  created: boolean;
  migrated: boolean;
  seeded: boolean;
}

/**
 * Make this workspace's database exist and be usable.
 *
 * A newly created database is migrated (and optionally seeded); an existing one
 * is left alone unless migration is explicitly requested, because re-running
 * migrations on every start would be slow and occasionally destructive.
 */
export async function ensureWorkspaceDatabase(options: {
  identity: WorkspaceIdentity;
  databaseUrl: string;
  env: Record<string, string>;
  projectRoot: string;
  hooks?: BootstrapHooks;
  migrate?: boolean;
  seed?: string | boolean;
}): Promise<EnsureDatabaseResult> {
  const name = databaseNameOf(options.databaseUrl);
  const existed = await databaseExists(options.databaseUrl, name);

  // Existing is not the same as usable. The provenance table is written only
  // after migrations succeed, so its absence means a previous attempt died
  // part-way and this database is incomplete. Treating "exists" as "ready"
  // would silently run the app against a half-built schema.
  const bootstrapped = existed ? await hasProvenance(options.databaseUrl) : false;

  if (!existed) {
    step("database", `creating ${c.cyan(name)}`);
    await createDatabase(options.databaseUrl, name);
  } else if (!bootstrapped) {
    step("database", `${c.yellow("incomplete")} from an earlier run; finishing setup`);
  }

  const context = buildBootstrapContext({
    identity: options.identity,
    env: options.env,
    databaseUrl: options.databaseUrl,
    projectRoot: options.projectRoot,
  });

  const shouldMigrate = options.migrate === true || !bootstrapped;
  let migrated = false;

  if (shouldMigrate && options.hooks?.migrate) {
    step("database", bootstrapped ? "applying migrations" : "running initial migration");
    try {
      await options.hooks.migrate(context);
      if (options.hooks.install) await options.hooks.install(context);
    } catch (caught) {
      // Leave nothing half-built behind. A database we just created is worth
      // nothing on its own, and keeping it would make the next run believe
      // setup had already happened.
      if (!existed) {
        step("database", "initial setup failed; removing the empty database");
        await dropDatabase(options.databaseUrl, name).catch(() => undefined);
      }
      throw caught;
    }
    migrated = true;
  }

  // Written only after migrations succeed — this is the marker the next run
  // reads. Migration tools also refuse to run against a schema that already
  // contains tables, so WorkTrellis must not be what puts a table there first.
  await recordProvenance(options.databaseUrl, options.identity);

  let seeded = false;
  if (options.seed) {
    const named = typeof options.seed === "string" ? options.seed : null;
    const seeder = named
      ? options.hooks?.seeds?.[named]
      : options.hooks?.seed;

    if (!seeder) {
      throw new WorkTrellisError(
        named ? `No seed named "${named}" is configured.` : "No default seed is configured.",
        {
          remediation: options.hooks?.seeds
            ? `Available seeds: ${Object.keys(options.hooks.seeds).join(", ")}`
            : "Add a `db.seed` hook to worktrellis.config.ts.",
        },
      );
    }

    step("database", `seeding${named ? ` (${named})` : ""}`);
    await seeder(context);
    seeded = true;
  }

  return { created: !existed, migrated, seeded };
}
