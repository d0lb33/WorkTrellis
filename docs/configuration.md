# Configuration reference

WorkTrellis loads the first `worktrellis.config.ts`, `.mts`, `.js`, or `.mjs`
found while walking from the current directory to the filesystem root.

```ts
import { defineConfig } from "worktrellis";

export default defineConfig({
  configVersion: 1,
  // ...
});
```

## Top-level fields

| Field | Required | Purpose |
| --- | --- | --- |
| `configVersion` | yes | Version of the configuration contract; currently `1` |
| `project` | yes | DNS-safe namespace for resources and hostnames |
| `services` | yes | Shared services required by the project |
| `env` | yes | Maps resolved context to WorkTrellis-owned variables |
| `processes` | yes | Processes supervised by `worktrellis up` |
| `db` | no | Migration, installation, and seed hooks |
| `baseEnvFile` | no | Read-only secrets file; defaults to `.env` |
| `criticalKeys` | no | Derived keys whose `.env` conflicts fail doctor |
| `extraPorts` | no | Additional deterministic per-worktree ports |
| `url` | no | URL provider, wildcard behavior, and base port |
| `gc` | no | Retention policy for inactive workspaces |
| `doctor` | no | Project-specific diagnostic checks |

## Services

One service of each kind may be declared:

```ts
services: [
  {
    kind: "postgres",
    version: "16",
    image: "postgres:16-alpine",
    port: 5432,
    superuser: "postgres",
    password: "postgres",
    serverArgs: ["max_connections=300"],
  },
  { kind: "redis", version: "7", port: 6379 },
  {
    kind: "minio",
    apiPort: 9000,
    consolePort: 9001,
    region: "us-east-1",
  },
  { kind: "mailpit", smtpPort: 1025, uiPort: 8025 },
],
```

Compatible definitions share one machine-level container and volume. Different
service definitions receive different stack identities and report a port
conflict rather than silently connecting a project to the wrong service.

## Environment profile

`env(context)` receives:

- `workspace`: stable identity, database/bucket/Redis names, and ports;
- `services`: resolved endpoints with URL helpers;
- `url`: app URL, listen port, cookie domain, and provider variables;
- `baseEnv`: a frozen view of the secrets file.

Return only variables WorkTrellis should own. Return `undefined` to omit a key.

```ts
env: ({ workspace, services, url }) => ({
  DATABASE_URL: services.postgres?.urlFor(workspace.databaseName),
  REDIS_URL: services.redis?.urlFor(workspace.redisDb),
  PORT: String(url.listenPort),
  APP_URL: url.appUrl,
}),
```

## Processes

Commands are arrays, never shell strings:

```ts
processes: [
  {
    name: "app",
    command: { node: ["node_modules/vite/bin/vite.js"] },
    bindsAppPort: true,
    restart: "on-crash",
    maxRestarts: 3,
    readyWhen: { logMatch: /ready/i, timeoutMs: 60_000 },
  },
  {
    name: "worker",
    command: { bin: "node", args: ["worker.mjs"] },
    dependsOn: ["app"],
  },
],
```

Dependency names must exist and dependency cycles are rejected while loading
the configuration.

## Database hooks

```ts
db: {
  schemaFingerprintFiles: ["prisma/schema.prisma", "prisma/migrations"],
  migrate: (context) =>
    context.exec(context.bin("prisma"), ["migrate", "deploy"]),
  seed: (context) =>
    context.exec(context.bin("tsx"), ["prisma/seed.ts"]),
  seeds: {
    demo: (context) =>
      context.exec(context.bin("tsx"), ["prisma/demo-seed.ts"]),
  },
},
```

The schema fingerprint selects a reusable template database. New worktrees are
cloned from the matching template, then `afterClone` runs when configured.

Hooks receive the exact worktree database URL, an executable resolver, a
process runner, a SQL helper, and the resolved environment.

Production dumps are application data and should normally be restored by a
checked-in package script invoked through `worktrellis run`. This keeps
sanitization, format selection, and destructive safety policy in the project.

## URL providers

```ts
url: {
  provider: "auto", // "auto" | "portless" | "direct"
  wildcard: true,
  basePort: 3000,
},
```

`auto` prefers portless and falls back to a deterministic localhost port.
`direct` always uses the port. `portless` treats an unavailable proxy as an
error.

## Configuration compatibility

The npm package follows semantic versioning. `configVersion` is a separate,
integer protocol for the config file itself:

- additive fields do not require a new configuration version;
- a breaking interpretation change requires a new version;
- unknown versions fail with a remediation message.
