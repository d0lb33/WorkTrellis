# Troubleshooting guide

## Contents

- Diagnose before changing
- Port conflicts
- Compose and scope problems
- Environment problems
- Process and orphan problems
- Portless and Tailscale problems
- Resource isolation problems

## Diagnose before changing

Collect safe evidence:

```bash
worktrellis doctor
worktrellis info
worktrellis status
worktrellis services status
worktrellis services variants
worktrellis env --explain
```

Inspect Git status, the dependency declaration, lockfile resolution, resolved
package path, package version, executable version, `configVersion`, Compose
definitions, package scripts, and ignored local config. Do not print `.env`,
provider environment, connection-string passwords, or credentials.

Check for a local `node_modules/worktrellis` symlink. A linked 0.3 executable
can make a config-version-3 checkout work even when the manifest and lockfile
would install an incompatible 0.2 release.

Classify the failure before editing:

- configuration validation;
- missing tool or daemon;
- port ownership;
- Compose health;
- resource provisioning;
- child process readiness;
- URL routing;
- authentication origin;
- orphaned process; or
- cleanup failure.

## Port conflicts

Check whether:

- Compose still publishes a port WorkTrellis owns;
- two named ports use one fixed `hostPort`;
- a non-WorkTrellis process owns the selected port;
- a stale managed process remains;
- machine overrides select a busy port; or
- an app ignores the generated port and starts on its framework default.

Do not kill an arbitrary process. Resolve its command, working directory, and
relationship to WorkTrellis first.

Use `worktrellis services adopt --<port-name>-port <port>` only for a real
machine-local compatibility need. Prefer deterministic allocation.

## Compose and scope problems

For a shared stack conflict:

1. run `worktrellis services variants <stack> --json`;
2. distinguish the desired `compatibilityId` from each physical
   `projectName`/`stackId`;
3. compare Compose contents, named ports, and declared environment inputs
   without exposing values;
4. inspect stateful mount topology, resolved images, commands, entrypoints,
   configured environment, and persisted `volumeDataVersions`;
5. identify every live or unverifiable consumer;
6. look for relative bind mounts, builds, and `env_file`;
7. confirm all callers use WorkTrellis 0.4 or newer and compatible config; and
8. decide whether to reconcile, create a fresh variant, or change scope.

Do not silence compatibility warnings by weakening stack identity.

Exit code `4` is an unresolved lineage decision, not a transient startup
failure. In an interactive terminal, cancel is the default. In automation,
choose explicitly:

```bash
worktrellis services reconcile <stack> --from <compose-project>
worktrellis up --new-variant <stack>
worktrellis services down --variant <compose-project>
```

Reconciliation is unavailable for anonymous volumes, unsafe bind or external
mount differences, incompatible data versions, or live consumers. There is no
force flag. Never choose a source by volume size or container recency, and
never delete the unselected variant to make the conflict disappear. Adding
`--volumes` is the only variant-data deletion path and requires explicit user
authorization.

If a legacy worktree is missing and its consumer cannot be verified, report it
for manual cleanup. Do not clear the lease or signal a PID without verified
process identity.

If a service is unhealthy, diagnose it through Compose logs and the
project-owned health check. WorkTrellis does not own container internals.

## Environment problems

Run `worktrellis env --explain` and inspect sources. Common causes:

- `.env` defines a key that should be generated;
- a real process environment variable overrides both sources;
- a process does not consume `.worktrellis/env`;
- a resource key was renamed without updating `env`;
- a required credential exists but is an empty string;
- credentials differ between Compose and the adapter; or
- an auth base URL is hard-coded instead of derived from `url.appUrl`.

Do not use `value ?? fallback` for a credential when empty strings must be
rejected. Validate required values once, name only the missing key in the
error, and keep Compose interpolation semantics consistent.

Add isolation-sensitive values to `criticalKeys`. Do not fix conflicts by
writing generated values into `.env`.

When authentication works locally but not through a private URL, inspect the
application's base URL, trusted origins, cookie security, and callback URLs.
Fix those in application configuration using WorkTrellis-generated URL
values. Do not move auth logic into WorkTrellis.

## Process and orphan problems

`worktrellis status` reports `orphaned` when the supervisor is gone but a
recorded child or app listener remains.

Use:

```bash
worktrellis down
worktrellis status
```

WorkTrellis should request cooperative shutdown and then reap only verified
leftovers. If it fails:

1. inspect recorded and live process identity;
2. check whether a package script spawned a detached child;
3. check whether the app changed its listener port;
4. check signal handling in wrappers and child processes;
5. preserve Portless long enough to perform route cleanup; and
6. add a regression test before changing reaper behavior.

Never report success while a verified child or app port remains alive. Never
signal a stale PID without identity verification.

## Portless and Tailscale problems

Separate responsibilities:

- WorkTrellis chooses the provider, name, and app port.
- Portless owns `.localhost`, certificates, proxy and route lifecycle.
- Portless owns Tailscale Serve, remote ports, URLs, and cleanup.
- Tailscale owns the tailnet and device connectivity.

If `auto` falls back to direct mode, read the fallback reason. If the project
requires Portless, use `--portless` to turn fallback into a visible failure.

If `--tailscale` fails:

1. verify Node 24 or newer;
2. verify Portless 0.15.5 or newer is installed;
3. verify Tailscale is connected and Portless setup works independently;
4. inspect Portless output;
5. confirm the app accepts the generated remote origin; and
6. leave Tailscale commands and Serve cleanup to Portless.

Do not add Tailscale API calls, Serve-state parsing, certificate copying, or
remote URL derivation to WorkTrellis. WorkTrellis may record the exact URL
returned by Portless and allow bounded cooperative wrapper cleanup.

## Resource isolation problems

### PostgreSQL

Confirm each worktree resolves a distinct database name and the application
uses the resolved URL. Do not substitute schemas for databases.

### Redis

Confirm every cache, queue, lock, pub/sub, and rate-limit consumer uses the
resolved database and prefix. A partially namespaced application is not
isolated.

### S3

Confirm each worktree uses the resolved bucket and that clients do not
override it with `.env`.

### Unsupported service

Use a workspace-scoped Compose stack if the service cannot isolate logical
state. Propose a custom adapter only when the protocol exposes a clear,
idempotent isolation unit.
