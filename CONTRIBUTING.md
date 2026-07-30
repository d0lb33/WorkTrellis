# Contributing

## Checks

From the WorkTrellis repository:

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
node bin/worktrellis.mjs --version
node bin/worktrellis.mjs self-check
npm pack --dry-run
```

Behavior changes need regression coverage. Changes to the public configuration
contract must state whether they are additive or require a new
`configVersion`.

The package source must remain project-agnostic. Project process names,
environment keys, migrations, dump policy, and arbitrary service definitions
belong in a consuming project's config, Compose files, and package scripts.

For infrastructure features, apply the boundary test from ADR 001:

> Does this coordinate or isolate Git worktrees?

If not, it belongs in Compose, a project script, the application, or a
dedicated tool.
