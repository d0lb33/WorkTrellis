# WorkTrellis Agent Guide

> Mirror policy: keep `AGENTS.md` and `CLAUDE.md` identical. Any substantive
> change to one must be applied to the other in the same commit.

## Mission and boundary

WorkTrellis coordinates isolated local-development environments across Git
worktrees. Before adding a feature, apply the boundary test from
[`docs/architecture/001-responsibility-boundary.md`](docs/architecture/001-responsibility-boundary.md):

> Does this coordinate or isolate Git worktrees?

If not, it belongs in a consuming project's Compose file, configuration,
package scripts, application, or a dedicated tool.

Projects own every Compose service, image, network, and volume definition.
WorkTrellis owns worktree identity, scoped Compose project names, host-port
publication, optional protocol-level resource isolation, generated
environment, diagnostics, and foreground development-process supervision.

## Non-negotiable invariants

- Do not add a built-in Compose service catalog or runtime preset. Copyable
  examples and init recipes are acceptable; runtime-owned service definitions
  are not.
- Resource adapters are protocol conveniences. They may provision a logical
  database, namespace, bucket, or similar resource, but must never choose or
  embed a Compose image.
- Keep machine, repository, and workspace Compose scopes semantically
  distinct. Machine-stack compatibility must include every input that changes
  the rendered Compose project.
- Treat the project's base environment file, normally `.env`, as read-only;
  never write values back to it. Generated workspace environment belongs in
  gitignored `.worktrellis/env`, while machine coordination state belongs in
  the WorkTrellis home directory.
- Normal diagnostics and errors must redact environment values. Commands whose
  explicit contract is to emit resolved environment data, such as
  `env --print`, are the exception and must remain intentional.
- Read-only and inspection commands must not start or stop containers, claim
  application ports, or repoint hostname-proxy routes.
- Destructive operations such as database reset and volume removal must remain
  explicit. Never make them an implicit part of `up`, `info`, `doctor`, or
  `status`.
- Keep the package project-agnostic. Application names, framework knowledge,
  migrations, dump policy, and arbitrary service vocabulary belong to the
  consuming project.
- Preserve Windows, macOS, and Linux support. Prefer Node APIs and the shared
  process utilities over shell-specific syntax or POSIX-only assumptions.

## Public contracts

- `src/types.ts` and exports from `src/index.ts` are public API.
- Treat CLI JSON output, exit codes, generated environment behavior, naming,
  and scope semantics as compatibility-sensitive contracts.
- Classify every public configuration change as additive or breaking. Breaking
  configuration changes require a deliberate `configVersion` increment and
  migration documentation; do not silently accept an obsolete version.
- Avoid exposing host paths or secret values unless the command explicitly
  promises them.

## Source map

- `src/core/` — configuration, identity, naming, state, and environment
  resolution.
- `src/platform/` — Compose rendering, container engines, ports, health, and
  scoped stack coordination.
- `src/resources/` — protocol-level resource adapters and provisioning.
- `src/supervise/` — foreground process lifecycle and orphan cleanup.
- `src/url/` — direct and Portless URL providers.
- `src/commands/` — CLI behavior; keep orchestration in the underlying modules
  when it is shared.
- `test/` — unit, regression, and opt-in Compose integration coverage.

## Development workflow

Use pnpm and make focused changes. Behavior changes and bug fixes require
regression tests, including relevant scope and failure cases. Do not commit
generated `dist/`, `node_modules/`, or `.tsbuildinfo` files.

Run the checks relevant to the change:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
node bin/worktrellis.mjs --version
node bin/worktrellis.mjs self-check
npm pack --dry-run
```

Infrastructure changes should also run the opt-in Compose integration suite
when a container engine is available:

```bash
WORKTRELLIS_COMPOSE_TEST=1 pnpm test test/compose.integration.test.ts
```

## Releases

Follow [`docs/publishing.md`](docs/publishing.md). Update `package.json` and
`CHANGELOG.md` together, validate the packed contents, and create a GitHub
release tagged exactly `v<package-version>`. The release workflow publishes to
npm through trusted publishing; do not run a manual `npm publish`.
