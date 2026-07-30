# Acceptance examples

These examples exercise the public boundary WorkTrellis intends to preserve:

- [`basic`](basic/worktrellis.config.ts) uses the copyable project-owned
  [`compose.worktrellis.yml`](compose.worktrellis.yml) recipe.
- [`stars`](stars/worktrellis.config.ts) models an app and worker sharing
  machine infrastructure while receiving isolated logical resources.
- [`stars-gotenberg`](stars-gotenberg/worktrellis.config.ts) adds an arbitrary
  service through a normal Compose file and a named port, without adding a
  WorkTrellis service adapter.

They are architecture fixtures, not standalone applications. Copy the relevant
pieces into a project rather than trying to start the example directories.
