---
name: worktrellis
description: Configure, adopt, validate, migrate, or troubleshoot WorkTrellis in a local development project. Use when an AI coding agent needs to give Git checkouts stable ports and URLs, coordinate project-owned Docker or Podman Compose services, preserve and reconcile machine-stack data lineages, isolate PostgreSQL databases, Redis namespaces, or S3 buckets, generate per-worktree environment variables, supervise local app and worker processes, integrate optional Portless or Tailscale access, or diagnose WorkTrellis scope, retained variants, environment, port, process, and orphan-cleanup problems.
---

# WorkTrellis

Set up reliable local environments without making WorkTrellis own the
application, Compose services, secrets, or URL-provider internals.

## Start with discovery

Inspect the project before editing it:

1. Read repository instructions such as `AGENTS.md` and `CLAUDE.md`.
2. Check Git status and preserve unrelated changes.
3. Detect the package manager from `packageManager` and lockfiles.
4. Inspect `package.json`, existing development scripts, framework config, and
   the app's host and port behavior.
5. Find Compose files and read their merged intent, including profiles,
   interpolation, health checks, volumes, build contexts, and published ports.
6. Inspect `.env.example` and environment-variable names. Do not print or copy
   secret values from `.env`.
7. Find database migrations, seeds, workers, and other foreground processes.
8. Check for an existing `worktrellis.config.*`, `.worktrellis/`, and Portless
   setup. Compare the version declared in `package.json`, the lockfile
   resolution, the resolved package path and version, and
   `worktrellis --version`. Call out local links or symlinks that make the
   checkout behave differently from a clean install. For an existing
   machine-scoped stack on WorkTrellis 0.4 or newer, inspect
   `worktrellis services variants <stack> --json` before changing its
   definition.
9. Verify Git, Node 22 or newer, and Docker or Podman Compose availability.
   Portless-backed URLs require Node 24 or newer. Tailscale sharing also
   requires Portless 0.15.5 or newer.

Read [setup-workflow.md](references/setup-workflow.md) before implementing a
new adoption. Read [configuration.md](references/configuration.md) whenever
creating or changing a WorkTrellis config.

## Apply the ownership test

Ask: "Does this coordinate or isolate local Git working trees?"

WorkTrellis owns identity, scope, deterministic host ports, logical resource
isolation, generated workspace environment, diagnostics, and foreground
development-process supervision.

Keep these concerns with their actual owners:

- Keep services, images, volumes, networks, builds, and container health in
  project-owned Compose files.
- Keep application commands, migrations, seeds, and restore logic in the
  project.
- Keep secrets in `.env`, the real process environment, or a secret manager.
- Keep hostname routing, certificates, route conflicts, Tailscale Serve, and
  remote URLs in Portless.
- Keep production orchestration outside WorkTrellis.

Read [responsibility-boundaries.md](references/responsibility-boundaries.md)
before proposing an adapter, convenience feature, URL change, or service
preset.

## Choose the task path

- For first-time setup, follow **Adopt a project** below.
- For an existing config, inspect the installed package version and
  `configVersion`, then follow **Change or migrate safely**.
- For a failure or stale process, read
  [troubleshooting.md](references/troubleshooting.md) before changing code.
- For phone access, configure ordinary Portless support first, leave Tailscale
  off by default, and enable it explicitly with `worktrellis up --tailscale`.

## Adopt a project

### 1. Design before editing

Create a small mapping:

| Existing concern | WorkTrellis representation |
| --- | --- |
| Compose group | One named stack and deliberate scope |
| Container listener | Named WorkTrellis port |
| PostgreSQL data | `postgresDatabase()` when per-worktree isolation is wanted |
| Redis data | `redisNamespace()` when callers honor its database and prefix |
| S3-compatible data | `s3Bucket()` when per-worktree buckets are wanted |
| HTTP or raw TCP dependency | Named endpoint through `compose.url()` or port |
| App and workers | Foreground `processes` |
| Derived connection values | `env(context)` |
| Secret inputs | Read-only `baseEnv` callbacks |

Choose the narrowest useful stack scope:

- `machine`: select one physical Compose/data lineage for compatible,
  self-contained definitions across local projects and worktrees.
- `repository`: share only among worktrees with the same Git common directory.
- `workspace`: create a separate Compose project for the current working tree.

Do not use a shared scope for relative bind mounts, relative build contexts, or
relative `env_file` paths. Use `workspace`, or make the shared Compose
definition self-contained.

For every machine-scoped stack, distinguish the desired `compatibilityId` from
the selected physical `projectName`/`stackId`. A definition change must never
be treated as permission to create new volumes or abandon retained data.

- Inspect retained lineages with `worktrellis services variants <stack>`.
- Add `volumeDataVersions` for project-owned named persistence when the project
  can assert its on-disk format. Equal values authorize reuse across otherwise
  differing stateful definitions; changed or removed values require a fresh
  lineage.
- Use `worktrellis services reconcile <stack> --from <compose-project>` only
  for a candidate WorkTrellis classifies as compatible and only after all live
  consumers are stopped.
- Use `worktrellis up --new-variant <stack>` for an intentional fresh-volume
  lineage. Never delete the retained source as part of that choice.
- Stop an unselected physical lineage only with
  `worktrellis services down --variant <compose-project>`. Omit `--volumes`
  unless the user explicitly authorizes permanent data deletion.
- Never copy, merge, upgrade, dump, restore, or delete application data on
  WorkTrellis's behalf. Those remain explicit project-owned operations.

### 2. Install and commit the contract

Use the detected package manager to install `worktrellis` as an exact
development dependency. Do not install it globally and do not change package
managers.

Commit these project files:

- the exact WorkTrellis development dependency and lockfile;
- `worktrellis.config.ts`;
- project-owned Compose files;
- package scripts that invoke WorkTrellis;
- `/.worktrellis/` in `.gitignore`; and
- `.env.example` containing names and safe placeholders, never secrets.

Never commit `.worktrellis/env`, `.worktrellis/local.json`, machine
coordination state, real credentials, or database dumps.

### 3. Preserve Compose ownership

Keep service definitions intact. Remove only host `ports:` mappings that
WorkTrellis will publish as named ports. Preserve container ports, health
checks, volumes, networks, profiles, commands, and environment behavior.

Declare every Compose interpolation input used by a WorkTrellis-managed stack
through `compose[].env`. Read sensitive values with a callback such as
`({ baseEnv }) => requiredEnv(baseEnv, "POSTGRES_PASSWORD")`, where the local
helper rejects missing, empty, and whitespace-only values without printing the
value.

Do not invent credentials or hide missing values behind fallbacks. Make
adapter credentials match the project-owned service definition. Remember that
Compose `${NAME:-default}` treats an empty value as missing while JavaScript
`value ?? default` does not; keep those semantics consistent.

### 4. Build the config

Use `configVersion: 3`. Give the project a stable lowercase DNS-safe name.
Define stacks, named ports, optional resources, derived environment,
foreground processes, and optional database hooks.

Keep `env(context)` synchronous and side-effect-free. Generate values such as
database URLs, scoped prefixes, bucket names, application URLs, cookie
prefixes, and the app port. Do not echo base secrets into diagnostics unless
the application truly needs the value.

Use argument arrays for processes, never shell command strings. Exactly one
app process should normally set `bindsAppPort: true`. Ensure the actual
framework listens on WorkTrellis's host and port in both Portless and
`--direct` modes.

### 5. Make the safe path normal

Prefer these package-script roles:

```json
{
  "scripts": {
    "dev": "worktrellis up",
    "dev:direct": "worktrellis up --direct",
    "dev:app": "worktrellis up --only app",
    "services:up": "worktrellis services up",
    "services:status": "worktrellis services status",
    "services:variants": "worktrellis services variants",
    "worktrellis:doctor": "worktrellis doctor",
    "worktrellis:env": "worktrellis env --explain"
  }
}
```

Rename or preserve the old development script if a WorkTrellis process still
needs to invoke it. Avoid recursive scripts such as a WorkTrellis `dev`
process calling the new `dev` script.

### 6. Validate proportionally

Run the read-only checks first, then start infrastructure and processes only
when the user asked for a working setup. Follow
[validation.md](references/validation.md).

At minimum:

```bash
worktrellis doctor
worktrellis info
worktrellis env --explain
worktrellis services status
worktrellis services variants
worktrellis up
worktrellis status
worktrellis down
```

Use the local package-manager executable, such as `pnpm exec worktrellis`.
Confirm cleanup after `down`. When isolation or scope changed, validate two
real Git worktrees and real Compose projects if prerequisites are available.

## Configure URLs and phone access

Prefer `url: { provider: "auto", basePort: 3000 }` unless the project requires
Portless. `auto` uses Portless when available and otherwise uses a deterministic
direct URL. `direct` always uses localhost. `portless` fails when Portless is
unavailable.

Keep personal choices in ignored `.worktrellis/local.json`:

```json
{
  "url": {
    "hostname": "my-app-local",
    "tailscale": false
  }
}
```

Treat `tailscale: false` as the normal local default. For temporary private
phone access, use:

```bash
worktrellis up --tailscale
```

Do not derive a Tailscale URL, change Serve state directly, install
certificates, or duplicate Portless routing logic. WorkTrellis supplies the
name and app port, records the exact provider-returned URL for live status, and
supervises cleanup; Portless owns remote allocation, sharing, and routes.

## Change or migrate safely

1. Read the installed version, changelog, and relevant migration guide.
2. Reconcile the version declared in the manifest, lockfile, installed package,
   local links, and executable output. A locally linked newer WorkTrellis can
   hide a clean-install failure.
3. Treat public types, config fields, generated environment, CLI JSON, exit
   codes, scope semantics, and naming as compatibility-sensitive.
4. Never silently reinterpret an obsolete `configVersion`.
5. Keep `.env` read-only and preserve locally ignored choices.
6. Run the existing project tests plus WorkTrellis diagnostics.
7. Revalidate concurrent worktrees when identity, naming, ports, Compose
   scopes, resources, generated environment, or cleanup behavior changes.
8. Before changing a machine stack, inspect all retained variants and verified
   consumers. If `up` exits with code `4`, do not retry around the conflict:
   explicitly choose a safe reconciliation source, a fresh variant, or cancel.

Interactive lineage conflicts default to cancel. Non-interactive automation
must supply `--new-variant <stack>` or run an explicit compatible
`services reconcile`; never infer the choice from recency, size, or a familiar
container name.

Do not bump WorkTrellis itself while adopting it in another project unless the
user explicitly requests a package upgrade.

## Report the result

Summarize:

- files changed;
- stack scopes and why they were chosen;
- selected physical machine lineages, retained variants, compatibility, and
  live or unverifiable consumers;
- isolated resources and generated environment keys;
- the normal local URL and direct-mode behavior;
- the explicit Tailscale command, if configured;
- checks run and any skipped prerequisite-dependent checks; and
- any project behavior that still prevents reliable isolation.

Never include secret values in the report.
