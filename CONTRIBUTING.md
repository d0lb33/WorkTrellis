# Contributing

WorkTrellis is currently developed inside a host repository while its public
package boundary is stabilized.

## Checks

From the host repository:

```bash
pnpm --filter worktrellis typecheck
pnpm --filter worktrellis build
pnpm --filter worktrellis test
pnpm worktrellis self-check
pnpm --filter worktrellis pack --dry-run
```

Changes to behavior need regression coverage. Changes to the public config
contract must document whether `configVersion` remains compatible.

The package source must remain project-agnostic: project processes, environment
names, migration commands, and policies belong in `worktrellis.config.ts`.
