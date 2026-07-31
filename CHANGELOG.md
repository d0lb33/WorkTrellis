# Changelog

All notable changes to WorkTrellis are documented here. The project follows
[Semantic Versioning](https://semver.org/).

## Unreleased

## 0.3.0 - 2026-07-30

### Breaking

- Configuration version 3 requires projects to provide PostgreSQL and S3
  credentials explicitly in their resource adapters. WorkTrellis no longer
  embeds image-specific development credentials.
- `worktrellis status --json` now omits private host paths and provider
  environment, and reports safe resource descriptions instead of raw
  credential-bearing resource objects.

### Added

- A thin `worktrellis up --tailscale` handoff that runs the app process through
  Portless. Portless remains the sole owner of Tailscale configuration, URLs,
  and cleanup.
- Workspace-local sharing opt-in through `.worktrellis/local.json`.
- A real Git worktree and Docker Compose smoke test that verifies machine,
  repository, and workspace scope behavior, generated environments, and
  cleanup. Missing external prerequisites produce an explicit skip reason.

### Changed

- All Portless-backed app processes now run through Portless, not only shared
  ones. Portless owns proxy startup, local route conflict detection,
  registration, framework adaptation, and cleanup; WorkTrellis only supplies
  its exact worktree name and deterministic app port.

### Fixed

- `worktrellis down` now gives supervised wrappers time to perform their own
  graceful cleanup before verified force-reaping, and reports failure instead
  of success when a managed process or application port remains alive.
- Orphan recovery now gives provider wrappers the same graceful cleanup window
  even when their supervisor is already gone, preserving Portless route and
  Tailscale cleanup.
- Windows shutdown now stops a wrapper's owned application tree first so the
  wrapper can observe application exit and finish provider cleanup before
  WorkTrellis force-escalates.
- Explicit Tailscale requests fail when Portless sharing is unavailable instead
  of silently degrading to a loopback-only URL.
- `worktrellis status` reports recorded children or listeners without a live
  supervisor as `orphaned` and returns a failing exit code.
- Diagnostic errors and structured status output redact secrets and
  credential-bearing URLs.
- Portless certificate state is no longer inspected or injected by
  WorkTrellis; Portless owns its trust and certificate lifecycle completely.

## 0.2.3 - 2026-07-30

### Changed

- `worktrellis info` now reports each exact derived Docker Compose project name
  and its scope, including the same data in JSON output.

## 0.2.2 - 2026-07-30

### Added

- An explicit warning before a worktree starts a second machine-scoped Compose
  compatibility variant, including the resolved `compose.env` keys to compare.

### Fixed

- Multiplexed child processes can no longer erase sibling terminal output with
  destructive clear-screen control sequences.

## 0.2.1 - 2026-07-30

### Added

- Gitignored workspace-local Portless hostname overrides with machine-wide
  collision leases.

## 0.2.0 - 2026-07-30

### Breaking

- Configuration version 2 replaces container-specific `services` with scoped
  Compose stacks.
- PostgreSQL, Redis, and object-storage isolation are explicit `resources`.
- `extraPorts` is replaced by `processPorts`.
- Configuration version 1 and legacy `.devstack` state are not supported.

### Added

- Machine-, repository-, and workspace-scoped Compose projects.
- Project-owned Compose-file composition and arbitrary named endpoint ports.
- Generic TCP, HTTP, PostgreSQL, Redis, and SMTP reachability probes.
- Automatic object-storage bucket provisioning.
- Typed, arbitrary resource maps plus a public custom-adapter contract.
- Protocol helpers for PostgreSQL databases, Redis namespaces, and S3 buckets.
- A documented responsibility boundary and three acceptance examples,
  including custom Gotenberg composition.

## 0.1.0

### Added

- Shared PostgreSQL, Redis, MinIO, and Mailpit services.
- Per-worktree databases, buckets, Redis namespaces, URLs, and ports.
- Generated environment snapshots with explicit precedence.
- Process supervision, readiness dependencies, and orphan cleanup.
- Database templates, migration hooks, seeds, and clone hooks.
- Direct and Portless URL providers.
- Environment-aware execution, diagnostics, and introspection commands.
