# WorkTrellis

**One host, many worktrees.**

WorkTrellis is a local-development orchestrator for teams that run several Git
worktrees or clones on the same machine. It shares expensive infrastructure
such as PostgreSQL, Redis, MinIO, and Mailpit while giving every worktree its
own database, storage bucket, Redis namespace, URL, port, and resolved
environment.

It does not write `.env`. Secrets remain in the project's own environment file;
derived local values are written to the ignored `.worktrellis/env` snapshot.

## Why

A second worktree should not accidentally:

- connect to the first worktree's database;
- consume its background jobs;
- overwrite its uploaded files;
- reuse its authentication cookies; or
- fail because the usual development port is occupied.

WorkTrellis derives a stable identity from the repository and worktree path,
then provisions an isolated slice of shared local services.

## Requirements

- Node.js 22 or newer
- Git
- Docker or Podman with Compose support
- A JavaScript package manager for `worktrellis run`

## Install

```bash
pnpm add --save-dev worktrellis
```

Create `worktrellis.config.ts` in the repository root:

```ts
import { defineConfig } from "worktrellis";

export default defineConfig({
  configVersion: 1,
  project: "acme",

  services: [
    { kind: "postgres", version: "16" },
    { kind: "redis", version: "7" },
    { kind: "minio" },
    { kind: "mailpit" },
  ],

  url: { provider: "auto", basePort: 3000 },

  env: ({ workspace, services, url }) => ({
    DATABASE_URL: services.postgres?.urlFor(workspace.databaseName),
    REDIS_URL: services.redis?.urlFor(workspace.redisDb),
    S3_ENDPOINT: services.minio?.endpoint,
    S3_BUCKET: workspace.bucketName,
    SMTP_HOST: services.mailpit?.smtpHost,
    PORT: String(url.listenPort),
    APP_URL: url.appUrl,
  }),

  processes: [
    {
      name: "app",
      bindsAppPort: true,
      command: { node: ["node_modules/vite/bin/vite.js"] },
    },
  ],
});
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

## Daily use

```bash
pnpm exec worktrellis up                 # services + project processes
pnpm exec worktrellis down               # stop this worktree's processes
pnpm exec worktrellis status             # processes, services, and URL
pnpm exec worktrellis env --explain      # values and their sources
pnpm exec worktrellis exec -- <command>  # command with resolved environment
pnpm exec worktrellis run <script>       # package script with that environment
pnpm exec worktrellis list               # known worktrees across projects
```

Use `worktrellis run` for project operations that need this worktree's
database. For example, a `db:restore` package script can read `DATABASE_URL`
normally:

```bash
pnpm exec worktrellis run db:restore -- ./backups/latest.dump
```

That keeps dump format, safety checks, and application-specific normalization
in the project while WorkTrellis supplies the correct isolated target.

## Environment precedence

From lowest to highest priority:

1. the configured secrets file (`.env` by default);
2. WorkTrellis-derived values;
3. real variables already exported in the process environment.

The generated `.worktrellis/env` contains only derived values. It is useful for
tools not launched by WorkTrellis, but it must remain ignored and must not be
edited by hand.

## State

Per-worktree state lives in `<worktree>/.worktrellis`. Machine-wide service
definitions, port overrides, locks, and the workspace index live in
`~/.worktrellis`. Set `WORKTRELLIS_HOME` to override the machine-wide location.

## Configuration versions

`configVersion` versions the shape and meaning of `worktrellis.config.ts`. It is
separate from the npm package version. WorkTrellis rejects an unknown version
instead of silently interpreting a future or obsolete configuration.

The current configuration version is `1`.

## Documentation

- [CLI reference](docs/cli.md)
- [Configuration reference](docs/configuration.md)
- [Team adoption guide](docs/team-setup.md)
- [Migration from the internal `devstack` build](docs/migration-from-devstack.md)
- [Publishing guide](docs/publishing.md)

## Status

WorkTrellis is pre-1.0. The versioned configuration contract and documented
resource identities are treated as compatibility boundaries, but commands may
still grow before 1.0.

## License

MIT
