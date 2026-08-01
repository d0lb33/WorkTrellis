# Configuration reference

WorkTrellis loads the first `worktrellis.config.ts`, `.mts`, `.js`, or `.mjs`
found while walking from the current directory to the filesystem root.

```ts
import { defineConfig } from "worktrellis";

export default defineConfig({
  configVersion: 3,
  // ...
});
```

## Top-level fields

| Field | Required | Purpose |
| --- | --- | --- |
| `configVersion` | yes | Configuration contract version; currently `3` |
| `project` | yes | DNS-safe namespace for identities and hostnames |
| `compose` | yes | Scoped project-owned Compose stacks |
| `resources` | no | Named logical resource adapters |
| `env` | yes | Maps resolved context to generated variables |
| `processes` | yes | Foreground processes supervised by `up` |
| `db` | no | Project-owned PostgreSQL setup hooks |
| `baseEnvFile` | no | Read-only secrets file; defaults to `.env` |
| `criticalKeys` | no | Generated keys whose `.env` conflicts fail doctor |
| `processPorts` | no | Additional deterministic foreground-process ports |
| `url` | no | URL provider, wildcard behavior, and base app port |
| `gc` | no | Retention policy for inactive workspace records |
| `doctor` | no | Project-specific diagnostic checks |

## Compose stacks

Projects own every service definition. WorkTrellis selects a scope, generates
the Compose project identity, publishes named ports on `127.0.0.1`, checks for
conflicts, and starts or inspects the stack.

```ts
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
      pgadmin: {
        service: "pgadmin",
        containerPort: 80,
        probe: { kind: "http" },
      },
    },
  },
],
```

Every stack requires at least one project-owned Compose file. WorkTrellis
copies and merges the declared files, then adds a final generated override
containing host-port publications. Project files should not publish those same
ports themselves.

Available scopes:

| Scope | Lifetime |
| --- | --- |
| `machine` | Shared by the same named, identical definition across the host |
| `repository` | Shared by all worktrees of one Git repository |
| `workspace` | Separate for every worktree |

Machine compatibility includes project Compose contents, named port
declarations, resolved `compose[].env` values, and declared volume data
versions. If retained data exists under another identity, WorkTrellis prompts
for an explicit reconcile-or-fresh choice. Non-interactive commands exit with a
conflict before creating containers or volumes.

Machine- and repository-scoped definitions run from their stable directory
under `WORKTRELLIS_HOME`, so compatible worktrees do not fight over a project
directory. Keep shared-stack Compose files self-contained: avoid relative bind
mounts, build contexts, and relative `env_file` paths. Use `workspace` scope
when a service needs files from the current worktree.

Declare Compose interpolation inputs explicitly. Values can read the
project's read-only secrets file:

```ts
compose: [{
  // ...
  env: {
    POSTGRES_PASSWORD: ({ baseEnv }) => baseEnv.POSTGRES_PASSWORD,
  },
}],
```

Then `${POSTGRES_PASSWORD}` works normally in the Compose file. Declared values
participate in compatible stack identity without being written to generated
files. A real process environment variable still has normal Compose precedence.

Stateful services are conservative by default: in-place reconciliation requires
the same mount topology, resolved image, command, entrypoint, and configured
environment. A project can explicitly authorize compatible changes with named
volume generations:

```ts
compose: [{
  name: "infrastructure",
  scope: "machine",
  files: ["compose.yml"],
  volumeDataVersions: {
    postgres_data: "postgres-16",
  },
}]
```

Values are opaque project policy. Changing or removing a recorded generation
requires a fresh lineage; WorkTrellis never performs a data-format migration.

For each named port, `service` must match the merged Compose service name and
`containerPort` is its internal listener. `hostPort` is optional; when omitted,
WorkTrellis derives a stable port from the selected scope. Supported probes are
`tcp`, `http`, `postgres`, `redis`, `smtp`, and `none`. TCP is the default;
UDP ports default to `none`.

`compose.url(stack, port, scheme?)` returns a loopback URL for a declared named
port. Raw ports are available at `compose.stacks[stack].ports[port]`.

WorkTrellis has no runtime service catalog. PostGIS, PgAdmin, Gotenberg,
Mailpit, MSSQL, and new containers require no core change.

## Resource adapters

Containers and logical resources are separate concepts. A Compose service
starts PostgreSQL; `postgresDatabase()` derives and provisions a database for
the current worktree.

Resources are an arbitrary named map:

```ts
import {
  defineConfig,
  postgresDatabase,
  redisNamespace,
  s3Bucket,
} from "worktrellis";

export default defineConfig({
  // ...
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
      databaseCount: 16,
    }),
    uploads: s3Bucket({
      endpoint: { stack: "infrastructure", port: "s3" },
      isolation: "bucket",
      accessKey: ({ baseEnv }) => baseEnv.S3_ACCESS_KEY,
      secretKey: ({ baseEnv }) => baseEnv.S3_SECRET_KEY,
      region: "us-east-1",
    }),
  },

  env: ({ resources }) => ({
    DATABASE_URL: resources.database.url,
    REDIS_URL: resources.cache.url,
    REDIS_KEY_PREFIX: `${resources.cache.prefix}:`,
    S3_ENDPOINT: resources.uploads.endpoint,
    S3_BUCKET: resources.uploads.bucket,
  }),
});
```

Adapter names are chosen by the project and remain type-safe in `env`,
process callbacks, and doctor checks.

Built-in protocol adapters:

- `postgresDatabase()` creates a separate PostgreSQL database, never a schema;
- `redisNamespace()` supplies a logical database plus a collision-resistant
  key prefix;
- `s3Bucket()` ensures a worktree-specific S3-compatible bucket exists.

The helpers know protocols, not images. `postgresDatabase()` works with
`postgres`, `postgis/postgis`, or another compatible server. Credentials in an
adapter must match the project-owned Compose definition or secrets it uses.

Endpoint-only services need no adapter:

```ts
env: ({ compose }) => ({
  PGADMIN_URL: compose.url("infrastructure", "pgadmin"),
  GOTENBERG_URL: compose.url("documents", "gotenberg"),
}),
```

If a stateful service has no logical adapter, make its stack
`scope: "workspace"` to get a container per worktree. A community adapter can
instead isolate data inside a shared service.

## Custom adapters

`defineResourceAdapter()` preserves a custom adapter's resolved type:

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
      // Use the service's client to idempotently ensure resource.index.
    },
  });
```

`resolve` must be synchronous and side-effect-free because read-only commands
also resolve the environment. It receives the read-only `baseEnv` object for
credentials that live in the project's secrets file. `provision` is optional,
asynchronous, and must be idempotent. The endpoint references a declared named
Compose port, so WorkTrellis still validates the stack boundary and controls
host publication.

## Environment profile

`env(context)` receives:

- `workspace`: stable Git/worktree identity and foreground-process ports;
- `compose`: resolved stack identities, named ports, and URL helper;
- `resources`: the typed values returned by configured adapters;
- `url`: app URL, listen port, cookie domain, and provider variables;
- `baseEnv`: a frozen view of the secrets file.

Return only variables WorkTrellis should derive. Return `undefined` to omit a
key.

## Foreground processes

Commands are argument arrays, never shell strings:

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
    command: { node: ["worker.mjs"] },
    dependsOn: ["app"],
  },
],
```

`{ node: [...] }` launches the given JavaScript entry with the current Node
binary. `{ bin, args }` launches an executable directly without a shell.
Dependency names must exist and cycles are rejected.

The supervisor is intentionally limited to foreground local-development
processes, readiness, restart-on-crash, dependency ordering, and clean process
tree shutdown.

## Database hooks

Database hooks explicitly name a configured `postgresDatabase()` resource:

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

The schema fingerprint selects a reusable template database. New worktrees are
cloned from the matching template, then `afterClone` runs when configured.
Hooks receive the exact worktree database URL, executable resolver, process
runner, SQL helper, and resolved environment.

Database dumps remain project-owned. Restore them with a checked-in script:

```bash
worktrellis run db:restore -- ./backups/latest.dump
```

## URL providers

```ts
url: {
  provider: "auto", // "auto" | "portless" | "direct"
  wildcard: true,
  basePort: 3000,
},
```

`auto` prefers Portless and falls back to a deterministic localhost port.
`direct` always uses the port. `portless` treats an unavailable proxy as an
error.

### Workspace-local hostname

The default Portless hostname includes the fingerprinted workspace slug so
concurrent worktrees never collide. A developer may opt one checkout into a
short, local-only hostname with the ignored `.worktrellis/local.json` file:

```json
{
  "url": {
    "hostname": "acme-local"
  }
}
```

The value is the exact Portless alias below `.localhost`, not a URL, so this
example resolves to `https://acme-local.localhost`. It must contain lowercase
DNS labels and must omit the scheme, port, path, and `.localhost` suffix.

This setting changes `appUrl`, `rootDomain`, cookie-domain, tenant-template, and
wildcard-origin values. It does not change the workspace slug, database, Redis
namespace, bucket, Compose scope, or deterministic process ports.

WorkTrellis supplies this exact name and its deterministic app port to
Portless. Portless owns route conflict detection, registration, and cleanup;
it rejects a second live process that requests the same hostname rather than
allowing WorkTrellis to overwrite it. `--direct` bypasses Portless and therefore
does not use this hostname.

### Private Tailscale access

Every Portless-backed `worktrellis up` runs the configured port-binding process
through Portless, which owns proxy startup, local route registration, framework
adaptation, and cleanup. `--tailscale` additionally selects Portless's native
private-sharing mode. WorkTrellis supplies only the name and fixed app port
because it owns worktree identity and process supervision. It does not invoke
Tailscale, inspect Serve state, choose the remote port, or clean up either
route. It only records the exact private URL Portless returns for the live run.

Portless prints the private URL and supplies `PORTLESS_TAILSCALE_URL` to the
wrapped app. Its normal rules apply, including use of additional HTTPS ports
when another shared app already occupies port 443. Those allocations can
change as shared apps stop and restart, so use the URL Portless prints or the
`tailnet` value in `worktrellis status`; the bare tailnet node URL is not a
stable project identifier. This mode requires Portless 0.15.5 or newer, Node 24
or newer, and a working Portless Tailscale setup. Because sharing is explicit,
WorkTrellis fails the launch if those prerequisites are unavailable instead of
falling back to a local-only URL.

To make exposure the default for only one ignored worktree, use:

```json
{
  "url": {
    "hostname": "acme-local",
    "tailscale": true
  }
}
```

Portless removes its local route and Tailscale Serve route when the supervised
app exits. If WorkTrellis discovers an orphan after its supervisor has already
stopped, it still gives the verified wrapper a cooperative cleanup window
before using a forceful process-tree kill. On POSIX systems that means
signalling the wrapper; on Windows, WorkTrellis stops the wrapper's owned
application tree so Portless can observe the exit and clean up naturally. A
Tailscale-backed wrapper receives a longer bounded window because Portless's
public CLI may wait for Tailscale cleanup; WorkTrellis never inspects or edits
Serve state itself.

## Configuration compatibility

The npm package follows semantic versioning. `configVersion` is a separate
integer protocol:

- additive fields can remain on the current version;
- a breaking interpretation requires a new version;
- unsupported versions fail before infrastructure is changed.

WorkTrellis 0.4 accepts only `configVersion: 3`. See the
[v3 migration guide](migration-to-v3.md) for the credential and JSON-output
changes.
