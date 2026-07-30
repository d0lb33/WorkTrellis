# WorkTrellis

**One host, many worktrees.**

WorkTrellis coordinates local development across Git worktrees and clones. It
uses Docker Compose for containers while giving each worktree its own database,
Redis namespace, object-storage bucket, URL, process ports, and resolved
environment.

It does not write `.env`. Secrets stay in the project's own environment file;
derived local values are written to the ignored `.worktrellis/env` snapshot.

## Why

A second worktree should not accidentally:

- connect to the first worktree's database;
- consume its jobs or reuse its cache keys;
- overwrite its uploaded files;
- share authentication cookies; or
- fail because a development port is occupied.

WorkTrellis derives a stable identity from the repository and worktree path,
coordinates explicitly scoped Compose stacks, and provisions isolated logical
resources inside them.

## Requirements

- Node.js 22 or newer
- Git
- Docker or Podman with Compose support
- A JavaScript package manager for `worktrellis run`

## Install

```bash
pnpm add --save-dev --save-exact worktrellis
```

Create `worktrellis.config.ts` in the repository root:

```ts
import {
  defineConfig,
  postgresDatabase,
  redisNamespace,
  s3Bucket,
} from "worktrellis";

export default defineConfig({
  configVersion: 2,
  project: "acme",

  compose: [
    {
      name: "local",
      scope: "machine",
      files: ["compose.worktrellis.yml"],
      ports: {
        database: {
          service: "postgres",
          containerPort: 5432,
          probe: { kind: "postgres" },
        },
        redis: {
          service: "redis",
          containerPort: 6379,
          probe: { kind: "redis" },
        },
        s3: {
          service: "minio",
          containerPort: 9000,
          probe: { kind: "http", path: "/minio/health/live" },
        },
        mail: {
          service: "mailpit",
          containerPort: 1025,
          probe: { kind: "smtp" },
        },
      },
    },
  ],

  resources: {
    database: postgresDatabase({
      endpoint: { stack: "local", port: "database" },
      isolation: "database",
    }),
    cache: redisNamespace({
      endpoint: { stack: "local", port: "redis" },
      isolation: "namespace",
    }),
    storage: s3Bucket({
      endpoint: { stack: "local", port: "s3" },
      isolation: "bucket",
    }),
  },

  url: { provider: "auto", basePort: 3000 },

  env: ({ workspace, compose, resources, url }) => ({
    DATABASE_URL: resources.database.url,
    REDIS_URL: resources.cache.url,
    REDIS_KEY_PREFIX: `${resources.cache.prefix}:`,
    S3_ENDPOINT: resources.storage.endpoint,
    S3_BUCKET: resources.storage.bucket,
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: String(compose.stacks.local!.ports.mail),
    PORT: String(url.listenPort),
    APP_URL: url.appUrl,
    COOKIE_PREFIX: `acme-${workspace.slug}`,
  }),

  processes: [
    {
      name: "app",
      bindsAppPort: true,
      command: { node: ["node_modules/vite/bin/vite.js"] },
    },
  ],

  db: { resource: "database" },
});
```

Commit the referenced Compose file. It is ordinary project code:

```yaml
# compose.worktrellis.yml
services:
  postgres:
    image: postgis/postgis:16-3.5
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
    volumes:
      - postgres-data:/var/lib/postgresql/data
  redis:
    image: redis:7-alpine
    volumes:
      - redis-data:/data
  minio:
    image: minio/minio:latest
    command: ["server", "/data"]
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    volumes:
      - minio-data:/data
  mailpit:
    image: axllent/mailpit:latest

volumes:
  postgres-data:
  redis-data:
  minio-data:
```

Add the generated directory to `.gitignore`:

```gitignore
/.worktrellis/
```

Then:

```bash
pnpm exec worktrellis doctor
pnpm exec worktrellis up
```

## Compose is the extension language

Every service belongs in project-owned Compose files:

```yaml
# compose.dev.yml
services:
  gotenberg:
    image: gotenberg/gotenberg:8
```

Declare how WorkTrellis should scope that stack and publish its ports:

```ts
compose: [
  {
    name: "documents",
    scope: "workspace",
    files: ["compose.dev.yml"],
    ports: {
      gotenberg: { service: "gotenberg", containerPort: 3000 },
    },
  },
],

env: ({ compose }) => ({
  GOTENBERG_URL: compose.url("documents", "gotenberg"),
}),
```

WorkTrellis does not need a Gotenberg-, PostGIS-, PgAdmin-, or Mailpit-specific
adapter. They are either protocol-compatible infrastructure or named
endpoints. Resource adapters exist only where logical worktree isolation is
required.

The same rule handles databases WorkTrellis does not yet know. An MSSQL service
can use `scope: "workspace"` for one container per worktree without any
adapter. A future or community `mssqlDatabase()` adapter could instead isolate
databases inside a shared machine-scoped endpoint.

## Daily use

```bash
pnpm exec worktrellis up
pnpm exec worktrellis down
pnpm exec worktrellis status
pnpm exec worktrellis env --explain
pnpm exec worktrellis exec -- <command>
pnpm exec worktrellis run <script>
pnpm exec worktrellis services status
pnpm exec worktrellis list
```

Use `worktrellis run` for project operations that need the current worktree's
environment. For example:

```bash
pnpm exec worktrellis run db:restore -- ./backups/latest.dump
```

The project script owns dump download, validation, sanitization, restoration,
and post-restore migration. WorkTrellis supplies the isolated target.

## Infrastructure scopes

- `machine`: one compatible Compose project shared across repositories and
  worktrees on the host;
- `repository`: one Compose project shared by every worktree of a repository;
- `workspace`: one Compose project for this worktree.

WorkTrellis generates Compose project names and loopback-only host-port
overrides. Compose owns images, containers, networks, volumes, and health
checks. Shared-stack Compose interpolation inputs can be declared in
`compose[].env`, including callbacks that read the project's read-only
`baseEnv`.

## Environment precedence

From lowest to highest priority:

1. the configured secrets file (`.env` by default);
2. values returned by `env(context)`;
3. variables already exported in the process environment.

The generated `.worktrellis/env` contains only derived values. It is useful for
tools not launched by WorkTrellis, but it must remain ignored and must not be
edited by hand.

## State and compatibility

Per-worktree state lives in `<worktree>/.worktrellis`. Machine-wide stack
definitions, port overrides, locks, logs, and the workspace index live in
`~/.worktrellis`. Set `WORKTRELLIS_HOME` to override that location.

The current configuration contract is `configVersion: 2`. Version 1 is rejected
and old `.devstack` state is not imported. See the
[v2 migration guide](docs/migration-to-v2.md).

## Responsibility boundary

WorkTrellis is for worktree coordination and isolation. It is not a general
workflow engine, secret manager, database migration framework, dump-management
tool, production supervisor, or replacement for Compose and package scripts.
The complete boundary is recorded in
[ADR 001](docs/architecture/001-responsibility-boundary.md).

## Documentation

- [CLI reference](docs/cli.md)
- [Configuration reference](docs/configuration.md)
- [Team adoption guide](docs/team-setup.md)
- [Migration to configuration v2](docs/migration-to-v2.md)
- [Publishing guide](docs/publishing.md)
- [Acceptance examples](examples)

## License

MIT
