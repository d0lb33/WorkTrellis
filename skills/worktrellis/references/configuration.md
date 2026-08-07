# Configuration patterns

## Contents

- Minimal shape
- Compose stacks and ports
- Docker context service endpoints
- Built-in resources
- Generated environment
- Processes
- Database hooks
- URLs and local choices
- Custom adapters

## Minimal shape

WorkTrellis loads the first `worktrellis.config.ts`, `.mts`, `.js`, or `.mjs`
found from the current directory upward.

```ts
import { defineConfig } from "worktrellis";

export default defineConfig({
  configVersion: 3,
  project: "acme",
  compose: [],
  env: ({ url }) => ({
    PORT: String(url.listenPort),
    APP_URL: url.appUrl,
  }),
  processes: [],
});
```

Do not assume an empty Compose list permits Docker-free operation. Verify the
installed WorkTrellis release and its diagnostics before recommending that
shape.

Top-level responsibilities:

| Field | Purpose |
| --- | --- |
| `configVersion` | Public configuration protocol, currently `3` |
| `project` | Stable DNS-safe identity |
| `baseEnvFile` | Read-only secret input, default `.env` |
| `compose` | Project-owned Compose stacks and named ports |
| `resources` | Optional logical isolation adapters |
| `env` | Derived workspace environment |
| `processes` | Foreground local processes |
| `processPorts` | Additional deterministic host-process ports |
| `db` | Project-owned PostgreSQL lifecycle hooks |
| `criticalKeys` | Derived keys that must not conflict with `.env` |
| `url` | Direct or Portless URL selection |
| `doctor` | Project-specific diagnostic checks |
| `gc` | Inactive workspace retention |

## Compose stacks and ports

Define a project-local helper for required base environment values:

```ts
const requiredEnv = (
  env: Readonly<Record<string, string>>,
  key: string,
): string => {
  const value = env[key]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
};
```

Name only the missing key in the error. Never include the value.

```ts
compose: [
  {
    name: "infrastructure",
    scope: "machine",
    files: ["compose.worktrellis.yml"],
    volumeDataVersions: {
      postgres_data: "postgres-16",
      redis_data: "redis-7",
    },
    env: {
      POSTGRES_USER: ({ baseEnv }) =>
        requiredEnv(baseEnv, "POSTGRES_USER"),
      POSTGRES_PASSWORD: ({ baseEnv }) =>
        requiredEnv(baseEnv, "POSTGRES_PASSWORD"),
    },
    ports: {
      database: {
        service: "postgres",
        containerPort: 5432,
        probe: { kind: "postgres" },
      },
      cache: {
        service: "redis",
        containerPort: 6379,
        probe: { kind: "redis" },
      },
      storage: {
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
```

Port names are project vocabulary. The service name must match merged Compose.
Omit `hostPort` for deterministic allocation. Use a fixed `hostPort` only when
an external tool truly requires it and accept the collision risk.

WorkTrellis publishes declared ports on loopback by default. Remove
corresponding host port mappings from the project Compose files. Use
`compose.host` for the resolved connection address and
`compose.url(stack, port, scheme?)` for a complete endpoint; do not rebuild
either from a Docker API URL.

`volumeDataVersions` is keyed by the project-owned Compose volume name, not the
engine-prefixed physical volume name. Use it only for named volumes whose data
format the project understands. Equal persisted values authorize reuse when a
stateful signature differs; a changed or removed value requires a fresh
variant. Bind and external mounts always require strict equivalence, and
anonymous volumes cannot be reconciled.

This additive field does not replace Compose migrations or data upgrades.
WorkTrellis never copies, merges, or deletes volume contents.

## Docker context service endpoints

Docker owns context selection through `docker context use`, `DOCKER_CONTEXT`,
and its normal configuration. When the active Docker context points to a local
VM or another engine host, inspect both sides of service reachability:

- `bindAddress` is an IP address on the engine host where Docker publishes
  WorkTrellis-managed ports.
- `connectHost` is the hostname or IP address used by the machine running
  WorkTrellis to reach those ports.

Inspect before changing:

```bash
docker context show
docker context inspect
worktrellis services endpoint show
```

Record a machine-local mapping only after verifying the VM interface and route:

```bash
worktrellis services endpoint set \
  --bind-address 10.211.55.4 \
  --connect-host 10.211.55.4
```

Prefer an exact engine-host interface. Use `0.0.0.0` or `::` only when the
engine cannot publish on the exact interface and the developer has confirmed
the VM network and firewall restrict access. Wildcard publication exposes each
declared service port on every matching interface.

The mapping belongs under `WORKTRELLIS_HOME`, keyed and fingerprinted by Docker
context. Never put it in `worktrellis.config.ts`, `.env`, or Compose. A context
whose Docker API endpoint changes becomes stale and must be reviewed, then set
again or cleared explicitly:

```bash
worktrellis services endpoint clear
```

The Docker API endpoint, `bindAddress`, and `connectHost` are separate
concepts. WorkTrellis may coordinate the latter two, but it does not configure
the context, VM lifecycle, firewall, DNS, tunnels, or remote bind mounts.

## Built-in resources

```ts
import {
  postgresDatabase,
  redisNamespace,
  s3Bucket,
} from "worktrellis";

resources: {
  database: postgresDatabase({
    endpoint: { stack: "infrastructure", port: "database" },
    isolation: "database",
    user: ({ baseEnv }) => requiredEnv(baseEnv, "POSTGRES_USER"),
    password: ({ baseEnv }) =>
      requiredEnv(baseEnv, "POSTGRES_PASSWORD"),
  }),
  cache: redisNamespace({
    endpoint: { stack: "infrastructure", port: "cache" },
    isolation: "namespace",
    databaseCount: 16,
  }),
  uploads: s3Bucket({
    endpoint: { stack: "infrastructure", port: "storage" },
    isolation: "bucket",
    accessKey: ({ baseEnv }) => requiredEnv(baseEnv, "S3_ACCESS_KEY"),
    secretKey: ({ baseEnv }) => requiredEnv(baseEnv, "S3_SECRET_KEY"),
    region: "us-east-1",
  }),
},
```

Resource keys are arbitrary and remain type-safe. Credentials are mandatory
project inputs, not image-specific defaults. Ensure `.env.example`,
`compose[].env`, Compose interpolation, and resource adapters agree about
whether an empty value is valid. It normally is not.

Use `compose.url(stack, port, scheme?)` or
`compose.stacks[stack].ports[port]` for endpoint-only services.

## Generated environment

```ts
env: ({ workspace, compose, resources, url, baseEnv }) => ({
  DATABASE_URL: resources.database.url,
  REDIS_URL: resources.cache.url,
  REDIS_KEY_PREFIX: `${resources.cache.prefix}:`,
  S3_ENDPOINT: resources.uploads.endpoint,
  S3_BUCKET: resources.uploads.bucket,
  MAIL_PORT: String(compose.stacks.infrastructure!.ports.mail),
  PORT: String(url.listenPort),
  APP_URL: url.appUrl,
  COOKIE_PREFIX: `acme-${workspace.slug}`,
  OPTIONAL_PUBLIC_VALUE: baseEnv.OPTIONAL_PUBLIC_VALUE,
}),
```

Return only derived values and secret values the child process actually needs.
The base environment file remains read-only. WorkTrellis writes its generated
snapshot to ignored `.worktrellis/env`. A real process environment variable
retains highest precedence.

Use `criticalKeys` for derived variables whose stale definition in `.env`
would defeat isolation:

```ts
criticalKeys: [
  "DATABASE_URL",
  "REDIS_URL",
  "REDIS_KEY_PREFIX",
  "S3_BUCKET",
  "APP_URL",
  "PORT",
],
```

## Processes

```ts
processes: [
  {
    name: "app",
    bindsAppPort: true,
    color: "blue",
    command: {
      node: ["node_modules/example-framework/bin.js", "dev"],
    },
    readyWhen: {
      logMatch: /ready|listening/i,
      timeoutMs: 120_000,
    },
    restart: "on-crash",
    maxRestarts: 2,
  },
  {
    name: "worker",
    color: "magenta",
    command: {
      node: ["node_modules/tsx/dist/cli.mjs", "watch", "src/worker.ts"],
    },
  },
],
```

Confirm actual entrypoint paths against the installed dependency. Do not copy
the placeholder framework path.

A command can also be `{ bin: "executable", args: [...] }` or a callback using
resolved context. Avoid shell-specific syntax. Use a checked-in script for
pipes, redirects, and compound behavior.

## Database hooks

```ts
db: {
  resource: "database",
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

Use the project's actual migration command. Hooks receive the resolved
database URL. Keep dump download, validation, sanitization, and restore policy
in project scripts, then invoke them with `worktrellis run`.

## URLs and local choices

```ts
url: {
  provider: "auto",
  wildcard: true,
  basePort: 3000,
},
```

- `auto`: prefer Portless and fall back to a deterministic direct URL.
- `direct`: always use a localhost port.
- `portless`: require Portless and fail if unavailable.

The default Portless name includes the fingerprinted workspace slug. Override
one ignored checkout in `.worktrellis/local.json`:

```json
{
  "url": {
    "hostname": "acme-local",
    "tailscale": false
  }
}
```

The hostname is the exact Portless alias below `.localhost`. Omit scheme,
port, path, and `.localhost`.

Set `tailscale: true` only as a personal opt-in. Prefer leaving it false and
running `worktrellis up --tailscale` for a temporary private share.
Use Portless 0.15.5 or newer. Read the exact live private URL from Portless
output or `worktrellis status`; concurrent shares may receive `:8443` or
another dynamic HTTPS port.

## Custom adapters

Use a custom adapter only for protocol-level logical isolation:

```ts
import { defineResourceAdapter } from "worktrellis";

const searchIndex = (endpoint: { stack: string; port: string }) =>
  defineResourceAdapter({
    kind: "search-index",
    isolation: "index",
    endpoint,
    resolve: ({ workspace, endpoint }) => ({
      url: endpoint.url(),
      index: `${workspace.project}-${workspace.slug}`,
    }),
    describe: (resource) => `index ${resource.index}`,
    async provision(resource) {
      // Idempotently ensure only this logical index.
    },
  });
```

Keep `resolve` synchronous and side-effect-free. Make `provision` idempotent.
Do not select a container image or own a service definition in an adapter.
