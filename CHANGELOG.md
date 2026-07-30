# Changelog

All notable changes to WorkTrellis are documented here. The project follows
[Semantic Versioning](https://semver.org/).

## 0.2.0 - Unreleased

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
