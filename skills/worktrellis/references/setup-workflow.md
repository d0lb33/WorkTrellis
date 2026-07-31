# Project adoption workflow

## Contents

- Assess fit
- Inventory the project
- Convert Compose safely
- Model resources
- Model processes
- Wire package scripts
- Avoid common adoption mistakes

## Assess fit

Use WorkTrellis when the project needs one or more of these:

- stable local ports across unrelated projects;
- predictable URLs through Portless;
- concurrent normal and linked Git worktrees;
- separate PostgreSQL databases, Redis namespaces, or S3 buckets;
- coordinated project-owned Compose stacks;
- generated per-worktree environment values; or
- supervised app and worker process trees.

Do not adopt WorkTrellis only to:

- deploy or supervise production;
- replace Compose;
- create a service catalog;
- store secrets;
- manage certificates, tunnels, or Tailscale directly; or
- run a single command that has no worktree coordination need.

WorkTrellis currently expects Git, Node 22 or newer, and a reachable Docker or
Podman Compose environment. Do not advertise a Docker-free setup without first
verifying the installed version supports it.

## Inventory the project

Read, without mutating:

1. repository-local agent instructions;
2. `git status --short --branch`;
3. `package.json` and all lockfiles;
4. app framework config and the current development command;
5. every Compose file used for local development;
6. `.env.example`, then only the names from `.env`;
7. database schema, migrations, seed commands, and restore scripts;
8. worker, queue, scheduler, and other long-running commands;
9. existing Portless commands and environment variables; and
10. existing WorkTrellis files, manifest declaration, lockfile resolution,
    resolved package path, installed version, and executable version.

Record:

- Which process serves HTTP?
- How does it receive its host and port?
- Which services can be shared at the container level?
- Which data must differ per worktree?
- Which services require files from the current checkout?
- Which environment values are secrets versus derived values?
- Which package scripts are safe to call without recursion?

Do not print `.env`. Use tools that reveal variable names only, and avoid
command traces that could expand values.

Do not trust `node_modules` alone. A development symlink can execute a newer
or modified WorkTrellis than the manifest and lockfile would install on another
machine. Treat a `configVersion` that only works through that link as a
blocking migration problem.

## Convert Compose safely

Treat Compose as project-owned source code.

### Choose stack boundaries

Group services that should share a lifecycle and scope. A common
infrastructure stack may contain PostgreSQL, Redis, object storage, and mail
capture. A service that builds from the checkout or mounts source should
usually live in a workspace-scoped stack.

### Choose a scope

Use `machine` only when the rendered definition is compatible across callers
and independent of the current checkout. Machine stack identity includes
Compose contents, named ports, and declared Compose environment inputs.

Use `repository` when every worktree of one repository may share the same
service, but an unrelated clone or project must not.

Use `workspace` when each checkout needs its own container, build, bind mount,
volume, or un-isolatable service state.

### Transfer host-port ownership

For each host mapping such as `"5432:5432"`:

1. identify every local consumer;
2. declare a named WorkTrellis port for the service and container port;
3. select an appropriate reachability probe;
4. replace hard-coded host values with generated environment values; and
5. remove that host mapping from the project Compose file.

Do not remove `expose`, container listeners, health checks, or unrelated port
mappings. Avoid configuring the same host publication in both Compose and
WorkTrellis.

Supported probes are:

- `postgres` for PostgreSQL;
- `redis` for Redis;
- `smtp` for SMTP listeners;
- `http` with an optional path for HTTP health;
- `tcp` for generic TCP readiness; and
- `none` when a probe is not meaningful, including most UDP ports.

### Handle interpolation

If Compose uses `${NAME}`, declare the value through `compose[].env` when
WorkTrellis is responsible for starting that stack. Read project secrets from
the frozen `baseEnv` object:

```ts
env: {
  POSTGRES_PASSWORD: ({ baseEnv }) => baseEnv.POSTGRES_PASSWORD,
}
```

Do not copy the secret into the config, generated snapshot, logs, or final
report. Reject missing, empty, and whitespace-only required values explicitly.
Do not use `??` as an empty-string fallback when Compose uses
`${NAME:-default}` because their semantics differ.

## Model resources

Only add an adapter when logical state must differ inside a shared endpoint.

### PostgreSQL

Use `postgresDatabase()` for one database per worktree. Use
`isolation: "database"`, never a schema, because database-scoped facilities
such as notifications can cross schema boundaries.

Pass explicit credentials that match Compose:

```ts
database: postgresDatabase({
  endpoint: { stack: "infrastructure", port: "database" },
  isolation: "database",
  user: ({ baseEnv }) => baseEnv.POSTGRES_USER,
  password: ({ baseEnv }) => baseEnv.POSTGRES_PASSWORD,
})
```

Use database hooks for project-owned migrations and seeds. Do not teach the
adapter about Prisma, Drizzle, Rails, Django, or project-specific dump formats.

### Redis

Use `redisNamespace()` only when application consumers can honor the resolved
database and key prefix. Generate both the URL and a prefix environment
variable when queues, caches, locks, or pub/sub channels need namespacing.

Audit consumers before claiming isolation. A library that ignores the prefix
can still collide even if another part of the application uses it.

### S3-compatible storage

Use `s3Bucket()` to create one bucket per worktree. Credentials must match the
project's S3-compatible service or external local endpoint. Keep region and
endpoint semantics explicit.

### Endpoint-only services

Do not create empty adapters. For Mailpit, PgAdmin, Gotenberg, and generic HTTP
or TCP services, use a named port:

```ts
env: ({ compose }) => ({
  MAILPIT_URL: compose.url("infrastructure", "mailpit"),
})
```

### Services without logical isolation

Use `scope: "workspace"` when a stateful service cannot isolate by database,
namespace, bucket, tenant, or comparable protocol-level unit.

## Model processes

Use foreground processes only for local application processes whose lifecycle
belongs to the current checkout.

For each process:

- assign a unique name;
- use `{ node: [...] }` or `{ bin, args }`, never a shell string;
- set `bindsAppPort: true` only for the HTTP app;
- add `dependsOn` only for real startup ordering;
- use a specific readiness signal with a bounded timeout;
- choose restart-on-crash only when desired; and
- verify signals stop the full process tree.

Resolve a package's JavaScript entrypoint when possible. If invoking a package
script, preserve it under a different name before replacing `dev`, and make
sure it does not call WorkTrellis again.

Confirm the framework binds to the generated app host and port. Test both:

```bash
worktrellis up
worktrellis up --direct
```

## Wire package scripts

Use the existing package manager and naming conventions. Make the safe,
complete environment the normal `dev` command. Keep explicit scripts for
direct mode, infrastructure status, and diagnostics.

Do not force every project to use pnpm. Do not add a second package manager or
lockfile.

## Avoid common adoption mistakes

- Do not generate a config from Compose without reading application scripts.
- Do not rewrite `.env`.
- Do not add default database or object-storage credentials.
- Do not accept empty credential placeholders as configured secrets.
- Do not let a local package symlink hide a manifest or lockfile mismatch.
- Do not convert every service into a WorkTrellis adapter.
- Do not choose `machine` for relative builds or bind mounts.
- Do not leave duplicate host port mappings in Compose.
- Do not make Tailscale exposure the committed default.
- Do not hard-code a branch name into an app hostname.
- Do not call Portless or Tailscale APIs from WorkTrellis config.
- Do not use a destructive database reset to prove setup works.
