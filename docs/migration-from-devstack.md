# Migration from the internal `devstack` build

The unpublished internal build was renamed to WorkTrellis before the first
public release.

## Project changes

```diff
-import { defineDevstack } from "@ycp/devstack";
+import { defineConfig } from "worktrellis";

-export default defineDevstack({
+export default defineConfig({
+  configVersion: 1,
```

Rename:

- `devstack.config.ts` to `worktrellis.config.ts`;
- `.devstack/env` references to `.worktrellis/env`;
- `devstack` commands and package scripts to `worktrellis`;
- `DEVSTACK_HOME` to `WORKTRELLIS_HOME`.

## Local state

On first use, WorkTrellis copies per-worktree `.devstack` state into
`.worktrellis` and leaves the old directory untouched as a backup.

If `~/.devstack` exists and `~/.worktrellis` does not, WorkTrellis keeps using
the legacy machine-global directory. This deliberately preserves generated
Compose definitions and their data-volume identities.

Some persisted internal identifiers continue to contain `devstack`, including
Compose project names, PostgreSQL advisory-lock names, and the provenance
table. They are storage-format identifiers, not public configuration, and
remain stable to avoid data loss.
