<div align="center">

# WorkTrellis

**One host. Many worktrees. No port roulette.**

WorkTrellis gives every Git working tree a stable identity, deterministic
ports, isolated data, and a memorable URL, so every project and every branch
starts with the same development command.

[![CI](https://github.com/d0lb33/WorkTrellis/actions/workflows/ci.yml/badge.svg)](https://github.com/d0lb33/WorkTrellis/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/worktrellis)](https://www.npmjs.com/package/worktrellis)
[![Node.js](https://img.shields.io/node/v/worktrellis)](https://www.npmjs.com/package/worktrellis)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[Quick start](#quick-start) ·
[How it works](#how-it-works) ·
[Commands](#command-reference) ·
[Configuration](docs/configuration.md) ·
[Security](#security) ·
[Changelog](CHANGELOG.md)

</div>

---

## Contents

- [The problem](#the-problem)
- [How it works](#how-it-works)
- [Quick start](#quick-start)
- [What WorkTrellis guarantees](#what-worktrellis-guarantees)
- [The isolation model](#the-isolation-model)
- [Command reference](#command-reference)
- [Configuration](#configuration)
- [URLs and remote access](#urls-and-remote-access)
- [Environment and secrets](#environment-and-secrets)
- [Responsibility boundary](#responsibility-boundary)
- [Compatibility and support](#compatibility-and-support)
- [Versioning and stability](#versioning-and-stability)
- [Team adoption](#team-adoption)
- [Security](#security)
- [Documentation](#documentation)

---

## The problem

Nobody runs one thing at a time. The product app, the API, the admin portal,
the docs site, a client project, and a side project all want the same handful
of ports. Open a second project and they collide. Open a second worktree and
the collision spreads to data: two branches pointing at one database, draining
one queue, writing one bucket, and sharing one authentication cookie.

```text
 Before                                 After
 ───────────────────────────────────    ─────────────────────────────────────
 localhost:3000   which project?        https://storefront.localhost
 localhost:3001   who claimed this?     https://admin.localhost
 localhost:5173   app, or yesterday?    https://docs.localhost
 localhost:5432   whose database?       https://checkout.storefront.localhost
```

WorkTrellis treats every Git working tree, including a repository's ordinary
main checkout, as a first-class environment. It derives that environment's
identity, ports, resources, and URL, then hands your application a correct
environment and supervises it. You keep Docker Compose, your own commands, and
your own `.env`.

---

## How it works

One compatible infrastructure stack is shared at the container level and split
at the data level:

```text
                        project-owned Compose files
                 postgres · redis · object storage · mail
                                     │
                   one compatible stack, shared by scope
                                     │
          ┌──────────────────────────┼──────────────────────────┐
          │                          │                          │
  main checkout              feature worktree           bugfix worktree
  ─────────────              ────────────────           ───────────────
  own database               own database               own database
  own redis slice            own redis slice            own redis slice
  own bucket                 own bucket                 own bucket
  own port + URL             own port + URL             own port + URL
```

A single command drives the whole sequence:

```bash
pnpm dev   # -> worktrellis up
```

| Step | What happens |
| ---: | --- |
| 1 | Resolve project, repository, and worktree identity from Git |
| 2 | Start or reuse the correctly scoped Compose stacks |
| 3 | Publish named service ports on `127.0.0.1` and detect conflicts |
| 4 | Provision this worktree's database, cache namespace, and bucket |
| 5 | Resolve the URL and generate the derived environment |
| 6 | Supervise the configured processes as one group |
| 7 | Reap verified leftovers from interrupted runs |

The result is boring in the best way. A developer or a coding agent can open
another project or another branch without negotiating ports, keeping a
localhost cheat sheet, or wondering which checkout owns the data on screen.

---

## Quick start

### Requirements

| Requirement | Supported |
| --- | --- |
| Node.js | 22 or newer |
| Git | Any version with worktree support |
| Container engine | Docker or Podman with Compose v2 |
| Package manager | pnpm, npm, Yarn, or Bun |
| Operating system | macOS, Linux, Windows |

Named local HTTPS and tailnet sharing are optional [Portless](#urls-and-remote-access)
features and currently require Node.js 24 or newer.

### Install

```bash
pnpm add --save-dev --save-exact worktrellis
```

Add the generated directory to `.gitignore`:

```gitignore
/.worktrellis/
```

### 1. Keep services in Compose

WorkTrellis never invents or owns service definitions. Yours stay yours:

```yaml
# compose.worktrellis.yml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
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

Two rules for this file. Do not publish host ports, because WorkTrellis
generates the final loopback-only port override. Read credentials such as
`POSTGRES_PASSWORD` from your `.env` through the declared `compose[].env`
inputs shown below, so no secret is embedded in a committed definition.

### 2. Describe the worktree contract

```ts
// worktrellis.config.ts
import { defineConfig, postgresDatabase, redisNamespace } from "worktrellis";

export default defineConfig({
  configVersion: 3,
  project: "acme",
  baseEnvFile: ".env",

  compose: [
    {
      name: "infrastructure",
      scope: "machine",
      files: ["compose.worktrellis.yml"],
      env: {
        POSTGRES_PASSWORD: ({ baseEnv }) => baseEnv.POSTGRES_PASSWORD,
      },
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
      password: ({ baseEnv }) => baseEnv.POSTGRES_PASSWORD,
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

Credentials belong to the project. Resolve them from the read-only base
environment rather than embedding them in configuration.

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

<details>
<summary><b>Prefer to have a coding agent do the setup</b></summary>

Install the WorkTrellis skill with the
[open agent skills CLI](https://github.com/vercel-labs/skills):

```bash
npx skills add d0lb33/WorkTrellis --skill worktrellis
```

The installer detects Codex, Claude Code, Cursor, and other supported agents.
Add `--global` to make the skill available everywhere, or target one agent
without prompts:

```bash
npx skills add d0lb33/WorkTrellis --skill worktrellis --global --agent codex --yes
```

Then ask:

> Use `$worktrellis` to configure this project for stable ports, isolated
> local services, and safe concurrent worktrees.

The skill inspects the existing app, Compose files, package scripts, and
environment contract before changing anything, and it keeps Compose, secrets,
Portless, and Tailscale responsibilities in the right tools.

</details>

---

## What WorkTrellis guarantees

| Guarantee | Detail |
| --- | --- |
| **Stable identity** | Every working tree, main checkout included, gets a deterministic project, repository, and workspace identity derived from Git |
| **Deterministic ports** | Application and service ports are derived, not negotiated, published on `127.0.0.1`, and checked for conflicts before use |
| **Scoped infrastructure** | Compose projects are scoped to the machine, the repository, or one workspace, and shared only when their definitions are compatible |
| **Data isolation** | Each worktree receives its own logical database, cache namespace, and bucket inside shared protocol endpoints |
| **Generated environment** | Derived variables are written to gitignored `.worktrellis/env` with documented precedence; the project's `.env` is never written |
| **Supervised processes** | Readiness gates, dependency ordering, restart on crash, and a cooperative-then-forceful shutdown that verifies process identity |
| **Honest diagnostics** | `status`, `doctor`, `info`, and `list` are read only, support `--json`, and redact credentials |
| **Explicit destruction** | Database reset and volume removal are never implicit in `up`, `info`, `doctor`, or `status` |

---

## The isolation model

Compose stacks and logical resources solve different problems. Pick the
narrowest scope that is correct.

### Compose scopes

| Scope | Use it when | Result |
| --- | --- | --- |
| `machine` | Compatible infrastructure can be shared across local projects | One matching Compose project on the host |
| `repository` | Every worktree of one repository should share a dependency | One Compose project per Git repository |
| `workspace` | The service cannot safely isolate data internally | One Compose project per worktree |

Machine stacks are shared only when their Compose files, named ports, declared
interpolation inputs, and volume data generations match. When retained data
exists under another compatibility identity, WorkTrellis requires an explicit
choice: reconcile a proven-compatible lineage in place, or start a fresh
variant. Non-interactive runs fail safely until that choice is supplied.

For deliberate stateful upgrades, projects can declare opaque data-format
generations by named Compose volume:

```ts
volumeDataVersions: {
  postgres_data: "postgres-16",
  redis_data: "redis-7",
}
```

Keeping a generation asserts that the project has verified reuse is safe.
Changing it creates a new lineage. Split services into separate machine stacks
when they need independent upgrade lifecycles. See
[machine-stack lineages](docs/machine-stack-lineages.md).

### Resource adapters

Adapters carve worktree-specific slices out of shared endpoints:

| Adapter | Creates |
| --- | --- |
| `postgresDatabase()` | A worktree-specific PostgreSQL database, never a schema |
| `redisNamespace()` | A logical database plus a collision-resistant key prefix |
| `s3Bucket()` | A worktree-specific S3-compatible bucket |
| `defineResourceAdapter()` | Your own protocol adapter, with its resolved type preserved |

Adapters know protocols, not images. `postgresDatabase()` works against
`postgres`, PostGIS, or any compatible server the project chooses.

### Compose is the extension language

Adding an arbitrary local dependency should never require a WorkTrellis
plugin. Put it in Compose, publish a named port, and expose its URL:

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
    ports: { api: { service: "documents", containerPort: 3000 } },
  },
],

env: ({ compose }) => ({
  DOCUMENT_SERVICE_URL: compose.url("documents", "api"),
}),
```

Reach for a resource adapter only when WorkTrellis must create a logical,
worktree-specific slice inside a shared protocol endpoint. A future MSSQL
database adapter makes sense. A Gotenberg service adapter does not.

---

## Command reference

| Command | Purpose | Effect |
| --- | --- | --- |
| `up` | Start stacks, provision resources, write the environment, supervise processes | mutates |
| `down` | Stop this worktree's supervised processes; shared stacks stay up | mutates |
| `status` | Worktree URL, process state, stack health, resolved resource names | read only |
| `doctor` | Node, Git, engine, stack reachability, environment conflicts, project checks | read only |
| `info` | Identity, exact derived Compose project names and scopes, process ports | read only |
| `list` | Every worktree this machine knows about | read only |
| `url` | This worktree's URL, with optional `--tenant <subdomain>` | read only |
| `env` | The resolved environment, with `--explain`, `--json`, or `--print <key>` | read only |
| `exec -- <cmd>` | Run an executable with the resolved worktree environment | your command |
| `run <script>` | Run a package script with the resolved worktree environment | your script |
| `services <sub>` | `up`, `down`, `restart`, `status`, `logs`, `adopt` | by subcommand |
| `db <sub>` | `url`, `migrate`, `seed`, `reset` | by subcommand |
| `self-check` | Verify the package stayed project agnostic | read only |

Common flags for `up`:

```text
--only <names>      Start only the comma-separated process names
--no-services       Do not start stopped Compose stacks
--direct            Force http://localhost:<port>
--portless          Require a Portless hostname
--tailscale         Ask Portless to share the app on your tailnet
--migrate           Run the configured migration hook
--seed[=<name>]     Run the default or a named seed hook
```

Exit codes are stable and scriptable:

| Code | Meaning |
| ---: | --- |
| `0` | Success |
| `1` | Check or health failure |
| `2` | Invalid CLI usage |
| `3` | Missing environment requirement |
| `4` | Resource conflict |
| `5` | Supervised child process failure |

Full details live in the [CLI reference](docs/cli.md).

---

## Configuration

A single `worktrellis.config.ts` describes the whole contract. WorkTrellis
loads the first `worktrellis.config.ts`, `.mts`, `.js`, or `.mjs` found while
walking up from the current directory.

| Field | Required | Purpose |
| --- | :-: | --- |
| `configVersion` | yes | Configuration contract version, currently `3` |
| `project` | yes | DNS-safe namespace for identities and hostnames |
| `compose` | yes | Scoped, project-owned Compose stacks |
| `env` | yes | Maps resolved context to generated variables |
| `processes` | yes | Foreground processes supervised by `up` |
| `resources` | no | Named logical resource adapters |
| `db` | no | Project-owned PostgreSQL hooks |
| `baseEnvFile` | no | Read-only secrets file, defaults to `.env` |
| `criticalKeys` | no | Generated keys whose `.env` conflicts fail `doctor` |
| `processPorts` | no | Additional deterministic foreground-process ports |
| `url` | no | URL provider, wildcard behavior, and base app port |
| `gc` | no | Retention policy for inactive workspace records |
| `doctor` | no | Project-specific diagnostic checks |

See the [configuration reference](docs/configuration.md) for the full schema,
custom adapters, database hooks, and process options.

---

## URLs and remote access

Install [Portless](https://www.npmjs.com/package/portless) alongside
WorkTrellis for named local HTTPS:

```bash
pnpm add --save-dev --save-exact portless
```

With Portless available, the default `auto` provider gives each worktree a
named local HTTPS URL:

```text
https://feature-checkout-a1b2c3d4.acme.localhost
```

When Portless is unavailable, `auto` falls back to a deterministic direct URL.
`--direct` requests a plain `http://localhost:<port>` explicitly. A developer
can pin a short local name in gitignored `.worktrellis/local.json`:

```json
{
  "url": {
    "hostname": "acme-local",
    "tailscale": false
  }
}
```

For testing on a phone or another device, `--tailscale` selects Portless's
private sharing mode:

```bash
pnpm exec worktrellis up --tailscale
```

Because sharing is explicit, the launch fails rather than quietly falling back
to a loopback-only URL when Portless sharing cannot start.

Use Portless 0.15.5 or newer for reliable HTTP/2 WebSocket and development HMR
support. Portless may allocate `:8443` or another HTTPS port when multiple apps
are shared, and that allocation can change after restarts. Use the private URL
printed at startup or shown as `tailnet` by `worktrellis status`, rather than
treating the bare tailnet node URL as a stable project URL.

> **Delegation boundary.** WorkTrellis supplies only a worktree-safe name and a
> deterministic app port. Portless owns proxy startup, route registration and
> conflicts, certificates and trust, framework binding, Tailscale Serve, remote
> URLs, and route cleanup.

---

## Environment and secrets

WorkTrellis never writes your `.env`.

Precedence, from lowest to highest:

1. the project's read-only secrets file;
2. values returned by `env(context)`;
3. variables already exported in the process environment.

Derived values are written to gitignored `.worktrellis/env` for project tools
WorkTrellis does not launch directly. Do not edit or commit that snapshot.

`env(context)` receives the workspace identity, resolved Compose stacks and
named ports, typed resource values, URL data, and a frozen view of the base
environment:

```bash
pnpm exec worktrellis env --explain     # every value, with its source
pnpm exec worktrellis env --print PORT  # one value, undecorated
```

Human-readable and diagnostic output redacts credential-looking values.
`env --print` is the deliberate exception, because emitting a resolved value is
its entire contract.

---

## Responsibility boundary

| WorkTrellis coordinates | Your project and existing tools own |
| --- | --- |
| Project, repository, and worktree identity | Compose services, images, networks, and volumes |
| Machine, repository, and workspace scopes | Application and worker commands |
| Deterministic host ports | Secrets and `.env` |
| Logical resource isolation | Migrations, seeds, and data restore policy |
| Generated workspace environment | Portless routing, certificates, and remote sharing |
| Process supervision and orphan cleanup | Production deployment and orchestration |

The boundary test is one question:

> Does this coordinate or isolate Git worktrees?

<details>
<summary><b>Five places you should not use WorkTrellis</b></summary>

1. **Production orchestration.** Use your deployment platform, Kubernetes,
   systemd, or another production process manager. WorkTrellis supervises
   local foreground development processes.

2. **Replacing Docker Compose.** Images, services, networks, volumes, health
   checks, and build contexts stay in project-owned Compose files. WorkTrellis
   scopes and coordinates Compose. It is not a service catalog.

3. **Managing secrets.** Use `.env` locally and a real secret manager for
   shared or deployed environments. WorkTrellis reads project secrets and
   never owns, generates, or writes them.

4. **Owning migrations, backups, or production data.** Schema migrations, seed
   policy, dump acquisition, sanitization, and restore logic stay in project
   tools. WorkTrellis points those tools at the correct isolated target.

5. **Becoming your build system.** Use your package manager, Turborepo, Nx, or
   CI platform for general task graphs.

</details>

Read [ADR 001](docs/architecture/001-responsibility-boundary.md) for the full
rationale.

---

## Compatibility and support

| Dimension | Status |
| --- | --- |
| Node.js | 22 or newer; 24 or newer for Portless named HTTPS and tailnet sharing |
| Operating systems | macOS, Linux, and Windows are first-class targets |
| Container engines | Docker or Podman with Compose v2 |
| Package managers | pnpm, npm, Yarn, and Bun project scripts |
| Module format | ESM only, with published TypeScript declarations |
| Public API | `worktrellis` exports plus `src/types.ts` |

Per-worktree state lives in `<worktree>/.worktrellis`. Machine-wide stack
definitions, port overrides, locks, logs, and the workspace index live in
`~/.worktrellis`. Set `WORKTRELLIS_HOME` to relocate it.

---

## Versioning and stability

The npm package follows [Semantic Versioning](https://semver.org/).
`configVersion` is a separate integer protocol, and WorkTrellis 0.4 accepts
only `configVersion: 3`.

- Additive configuration fields stay on the current version.
- A breaking reinterpretation requires a new `configVersion` and a migration
  guide.
- An unsupported version fails before any infrastructure is changed.
- CLI JSON output, exit codes, generated environment behavior, and scope
  semantics are treated as compatibility-sensitive contracts.

Upgrading is documented in the [changelog](CHANGELOG.md) and the
[v3 migration guide](docs/migration-to-v3.md).

---

## Team adoption

Commit `worktrellis` as a pinned development dependency, the config file, the
package scripts that call it, `/.worktrellis/` in `.gitignore`, and an
`.env.example` holding secrets and overrides only. Never commit
`.worktrellis/env`, machine port overrides, dumps, or real secrets.

A new developer's first day is five commands:

```bash
git clone <repository>
cd <repository>
cp .env.example .env
pnpm install
pnpm dev
```

The [team adoption guide](docs/team-setup.md) covers upgrade procedure, scope
policy, machine-local port adoption, and database dump handling.

---

## Security

- Generated Compose ports bind to loopback only.
- The project's base environment file is read only and never written back.
- Normal diagnostics and structured output redact credentials and
  credential-bearing URLs.
- Destructive operations stay explicit and never ride along with `up`, `info`,
  `doctor`, or `status`.
- WorkTrellis is a local development coordinator. It is not intended to hold
  production credentials, download production data, or expose container
  services beyond the local host.

Report a suspected vulnerability privately through the
[security advisory form](https://github.com/d0lb33/WorkTrellis/security/advisories/new)
rather than a public issue. See [SECURITY.md](SECURITY.md).

---

## Documentation

| Document | Contents |
| --- | --- |
| [CLI reference](docs/cli.md) | Every command, flag, and exit code |
| [Configuration reference](docs/configuration.md) | Full schema, adapters, hooks, and URL providers |
| [Team adoption guide](docs/team-setup.md) | Rollout, upgrades, and policy |
| [ADR 001](docs/architecture/001-responsibility-boundary.md) | The responsibility boundary |
| [Migration to v3](docs/migration-to-v3.md) | Credential and JSON output changes |
| [Acceptance examples](examples) | Working configuration fixtures |
| [Contributing](CONTRIBUTING.md) | Checks, coverage expectations, and rules |
| [Changelog](CHANGELOG.md) | Release history |

---

<div align="center">

Built for people who run more than one thing at a time.

[MIT License](LICENSE) · [Report an issue](https://github.com/d0lb33/WorkTrellis/issues) · [npm](https://www.npmjs.com/package/worktrellis)

</div>
