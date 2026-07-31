<div align="center">

# WorkTrellis

### One command. Every worktree. No collisions.

Run several branches of the same application at once, with isolated databases,
cache keys, object-storage buckets, URLs, ports, and process trees—without
duplicating infrastructure that can safely be shared.

[![CI](https://github.com/d0lb33/WorkTrellis/actions/workflows/ci.yml/badge.svg)](https://github.com/d0lb33/WorkTrellis/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/worktrellis)](https://www.npmjs.com/package/worktrellis)
[![Node.js](https://img.shields.io/node/v/worktrellis)](https://www.npmjs.com/package/worktrellis)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

</div>

---

Git worktrees make parallel branches cheap. Most local-development environments
still assume there is only one checkout.

Open a second worktree and suddenly both branches want port 3000, both point at
the same database, both consume the same queue, and both write to the same
bucket. The first app may keep running while the second quietly mutates its
data.

WorkTrellis turns a repository's local environment into something worktree-aware:

```text
                    one compatible Compose stack
                   PostgreSQL · Redis · MinIO · Mail
                                  │
                 ┌────────────────┼────────────────┐
                 │                │                │
            main worktree    feature worktree   bugfix worktree
            own database     own database       own database
            own Redis slice  own Redis slice    own Redis slice
            own bucket       own bucket         own bucket
            own URL + port   own URL + port     own URL + port
```

You keep using Docker Compose, your existing application commands, and your
project's `.env`. WorkTrellis coordinates the pieces that must differ between
worktrees and shares the pieces that do not.

## The pitch

After a project is configured, every checkout starts the same way:

```bash
pnpm dev
```

WorkTrellis then:

- identifies the current repository and worktree;
- starts or reuses the correctly scoped Compose stacks;
- publishes deterministic, loopback-only host ports;
- provisions an isolated logical database, Redis namespace, and bucket;
- generates the worktree's URLs and derived environment;
- starts the app and worker as one supervised process group; and
- cleans up verified leftovers from interrupted runs.

The result is boring in the best way: developers and coding agents can open
another worktree without negotiating ports or wondering which branch owns the
data they are looking at.

## Where WorkTrellis shines

### 1. Developing two features at the same time

Keep `main` running for comparison while a feature branch changes the schema,
background worker, or authentication flow. Each branch gets its own data and
application URL, so testing one does not disturb the other.

### 2. Agentic and parallel coding workflows

Give multiple coding agents separate Git worktrees. They can all run the
project's normal development command without guessing ports, sharing test data,
or killing one another's servers.

### 3. Applications with a shared local infrastructure stack

PostgreSQL, Redis, S3-compatible storage, and mail capture are inexpensive to
share at the container level but dangerous to share at the data level.
WorkTrellis reuses compatible containers while isolating databases, Redis
prefixes/logical databases, and buckets.

### 4. Dependencies that cannot be logically partitioned

Some services do not have a useful namespace or database concept. Give their
Compose stack `scope: "workspace"` and WorkTrellis will run one Compose project
per worktree with distinct host ports.

### 5. Teams that want one reliable onboarding command

Project configuration documents the required services, ports, resource
isolation, generated variables, processes, and health checks. A new developer
can clone, create `.env`, run `worktrellis doctor`, and use the same `pnpm dev`
as everyone else.

### 6. Testing from another device

Portless-backed apps can be shared temporarily through Tailscale:

```bash
pnpm exec worktrellis up --tailscale
```

WorkTrellis supplies the worktree-safe name and app port. Portless owns the
local route, certificates, Tailscale Serve configuration, remote URL, and
cleanup.

## What it owns—and what it leaves alone

| WorkTrellis coordinates | Your project or existing tools own |
| --- | --- |
| Worktree and repository identity | Compose services, images, networks, and volumes |
| Machine, repository, and workspace scopes | Application and worker commands |
| Deterministic host ports | Secrets and `.env` |
| Logical resource isolation | Schema migrations, seeds, and data restore policy |
| Generated worktree environment | Portless routing, certificates, and remote sharing |
| Foreground process supervision and orphan cleanup | Production deployment and orchestration |

That boundary is intentional. WorkTrellis is a local coordination layer, not a
new infrastructure platform.

## Quick start

### Requirements

- Node.js 22 or newer
- Git
- Docker or Podman with Compose support
- pnpm, npm, Yarn, or Bun for project scripts

Named HTTPS and Tailscale sharing are optional Portless features and currently
require Node.js 24 or newer.

Install and pin WorkTrellis as a development dependency:

```bash
pnpm add --save-dev --save-exact worktrellis
```

Add the generated directory to `.gitignore`:

```gitignore
/.worktrellis/
```

### 1. Keep services in Compose

WorkTrellis does not invent or own service definitions:

```yaml
# compose.worktrellis.yml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: postgres
    volumes:
      - postgres-data:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    volumes:
      - redis-data:/data

volumes:
  postgres-data:
  redis-data:
```

Do not publish host ports in this file. WorkTrellis generates the final
loopback-only port override.

### 2. Describe the worktree contract

Create `worktrellis.config.ts`:

```ts
import {
  defineConfig,
  postgresDatabase,
  redisNamespace,
} from "worktrellis";

export default defineConfig({
  configVersion: 3,
  project: "acme",
  baseEnvFile: ".env",

  compose: [
    {
      name: "infrastructure",
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
      },
    },
  ],

  resources: {
    database: postgresDatabase({
      endpoint: { stack: "infrastructure", port: "database" },
      isolation: "database",
      user: "postgres",
      password: "postgres",
    }),
    cache: redisNamespace({
      endpoint: { stack: "infrastructure", port: "redis" },
      isolation: "namespace",
    }),
  },

  url: { provider: "auto", basePort: 3000 },

  env: ({ workspace, resources, url }) => ({
    DATABASE_URL: resources.database.url,
    REDIS_URL: resources.cache.url,
    REDIS_KEY_PREFIX: `${resources.cache.prefix}:`,
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

Credentials belong to the project. For secrets, resolve them from the
read-only base environment instead of embedding them:

```ts
password: ({ baseEnv }) => baseEnv.POSTGRES_PASSWORD,
```

### 3. Make it the normal development command

```json
{
  "scripts": {
    "dev": "worktrellis up",
    "dev:direct": "worktrellis up --direct",
    "services:status": "worktrellis services status",
    "worktrellis:doctor": "worktrellis doctor"
  }
}
```

Then verify and start:

```bash
pnpm worktrellis:doctor
pnpm dev
```

## The isolation model

Compose stacks and logical resources solve different problems.

### Compose scopes

| Scope | Use it when | Result |
| --- | --- | --- |
| `machine` | Compatible infrastructure can be shared across local projects | One matching Compose project on the host |
| `repository` | All worktrees of one repository should share a dependency | One Compose project per Git repository |
| `workspace` | The service cannot safely isolate data internally | One Compose project per worktree |

Machine stacks are shared only when their Compose files, named ports, and
declared interpolation inputs are compatible. WorkTrellis warns before
starting a second variant and never prints secret values while explaining the
difference.

### Resource isolation

Built-in adapters provide logical isolation inside compatible endpoints:

- `postgresDatabase()` creates a worktree-specific PostgreSQL database;
- `redisNamespace()` creates a logical database and collision-resistant prefix;
- `s3Bucket()` creates a worktree-specific S3-compatible bucket.

Adapters know protocols, not container images. PostgreSQL can come from
`postgres`, PostGIS, or another compatible image chosen by the project.

## Compose is the extension language

Adding an arbitrary local dependency should not require a WorkTrellis plugin.
Put it in Compose, publish a named port through the config, and expose its URL
to the application:

```yaml
# compose.documents.yml
services:
  documents:
    image: gotenberg/gotenberg:8
```

```ts
compose: [
  {
    name: "documents",
    scope: "workspace",
    files: ["compose.documents.yml"],
    ports: {
      api: { service: "documents", containerPort: 3000 },
    },
  },
],

env: ({ compose }) => ({
  DOCUMENT_SERVICE_URL: compose.url("documents", "api"),
}),
```

Use a resource adapter only when WorkTrellis needs to create a logical,
worktree-specific slice inside a shared protocol endpoint. A future MSSQL
database adapter makes sense; a Gotenberg service adapter does not.

## Daily commands

```bash
# Start services, provision resources, and supervise app processes
pnpm exec worktrellis up

# Stop this worktree's foreground processes; shared Compose stacks stay up
pnpm exec worktrellis down

# Inspect this worktree without mutating infrastructure
pnpm exec worktrellis status
pnpm exec worktrellis info
pnpm exec worktrellis doctor

# Understand or consume the resolved environment
pnpm exec worktrellis env --explain
pnpm exec worktrellis exec -- <command>
pnpm exec worktrellis run <package-script>

# Operate the project-owned Compose stacks explicitly
pnpm exec worktrellis services status
pnpm exec worktrellis services up
pnpm exec worktrellis services down

# See every known worktree
pnpm exec worktrellis list
```

Project-owned scripts can consume the current worktree environment:

```bash
pnpm exec worktrellis run db:restore -- ./backups/sanitized.dump
```

The script still owns download, validation, sanitization, restoration, and
migration policy. WorkTrellis supplies the correct isolated target.

## URLs and optional phone access

Install Portless alongside WorkTrellis when you want named local HTTPS:

```bash
pnpm add --save-dev --save-exact portless
```

With Portless available, the default `auto` provider gives each worktree a
named local HTTPS URL:

```text
https://feature-checkout-a1b2c3d4.acme.localhost
```

When Portless is unavailable, `auto` falls back to a deterministic direct URL.
Use `--direct` to request plain `http://localhost:<port>` explicitly. Use
`--tailscale` only when you intentionally want private tailnet access:

```bash
pnpm exec worktrellis up --tailscale
```

A developer can keep local choices in ignored `.worktrellis/local.json`:

```json
{
  "url": {
    "hostname": "acme-local",
    "tailscale": false
  }
}
```

Portless owns proxy startup, route conflicts, certificates, local routing,
Tailscale Serve, remote ports, remote URLs, and route cleanup. WorkTrellis only
delegates the worktree name and deterministic app port.

## Environment and secrets

WorkTrellis never writes `.env`.

Environment precedence, from lowest to highest, is:

1. the project's read-only secrets file;
2. values returned by `env(context)`;
3. variables already exported in the process environment.

Derived values are written to ignored `.worktrellis/env` for project tools that
WorkTrellis does not launch directly. Do not edit or commit that snapshot.
Normal status and diagnostic output redacts credentials.

## Five places you should not use WorkTrellis

1. **Production orchestration.** Use your deployment platform, Kubernetes,
   systemd, or another production process manager. WorkTrellis supervises local
   foreground development processes.

2. **Replacing Docker Compose.** Keep images, services, networks, volumes,
   health checks, and build contexts in project-owned Compose files.
   WorkTrellis scopes and coordinates Compose; it is not a service catalog.

3. **Managing secrets.** Use `.env` for local secrets and an appropriate secret
   manager for shared or deployed environments. WorkTrellis reads project
   secrets but never owns, generates, or writes them.

4. **Owning migrations, backups, or production data.** Keep schema migrations,
   seed policy, dump acquisition, sanitization, validation, and restore logic in
   project tools. WorkTrellis can run those tools against the isolated target.

5. **Becoming your workflow or build system.** Use your package manager,
   Turborepo, Nx, CI platform, or domain workflow engine for general task
   graphs. WorkTrellis is narrowly responsible for coordinating and isolating
   local Git worktrees.

The boundary test is simple:

> Does this coordinate or isolate Git worktrees?

If not, it probably belongs somewhere else.

## State and compatibility

Per-worktree generated state lives in `<worktree>/.worktrellis`. Machine-wide
stack definitions, port overrides, locks, logs, and the workspace index live in
`~/.worktrellis`. Set `WORKTRELLIS_HOME` to override that location.

The current configuration contract is `configVersion: 3`. Unsupported versions
fail before infrastructure is changed. See the
[configuration reference](docs/configuration.md) and
[v3 migration guide](docs/migration-to-v3.md).

## Documentation

- [CLI reference](docs/cli.md)
- [Configuration reference](docs/configuration.md)
- [Team adoption guide](docs/team-setup.md)
- [Responsibility boundary](docs/architecture/001-responsibility-boundary.md)
- [Migration to configuration v3](docs/migration-to-v3.md)
- [Acceptance examples](examples)
- [Changelog](CHANGELOG.md)

## License

[MIT](LICENSE)
