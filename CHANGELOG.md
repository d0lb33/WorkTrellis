# Changelog

All notable changes to WorkTrellis will be documented here.

The project follows [Semantic Versioning](https://semver.org/).

## 0.1.0 - Unreleased

### Added

- Shared PostgreSQL, Redis, MinIO, and Mailpit services.
- Per-worktree databases, buckets, Redis namespaces, URLs, and ports.
- Generated environment snapshots with explicit precedence.
- Process supervision, readiness dependencies, and orphan cleanup.
- Database templates, migration hooks, seeds, and clone hooks.
- Direct and portless URL providers.
- `exec`, package-script, diagnostic, service, and introspection commands.
- Configuration contract version `1`.
- Compatibility with state created by the internal `devstack` build.
