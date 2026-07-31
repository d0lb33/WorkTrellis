# ADR 001: WorkTrellis responsibility boundary

## Status

Accepted for configuration version 3.

## Decision

WorkTrellis coordinates local Git worktrees. It owns:

- canonical worktree and repository identity;
- stable slugs, scoped Compose project names, deterministic app ports, and
  worktree-safe names supplied to URL providers;
- per-worktree PostgreSQL databases, Redis namespaces, and object buckets;
- generated `.worktrellis/env` snapshots;
- environment-aware `exec` and package-script execution;
- infrastructure coordination, diagnostics, and conflict detection; and
- foreground local-development process lifecycle.

WorkTrellis delegates:

| Concern | Owner |
| --- | --- |
| Containers, networks, volumes, container health | Docker/Podman Compose |
| Every image and service definition | Project-owned Compose files |
| Package scripts and task pipelines | Project package manager |
| Schema and application migrations | Project hooks and tools |
| Dump download, validation, sanitization, restoration | Project scripts |
| Secrets | Developer or secret manager |
| Hostname routing, proxy lifecycle, certificates, and remote sharing | Portless |
| Production process management | Deployment platform |

Compose is the infrastructure data plane. WorkTrellis contains no built-in
Compose service catalog or preset. It remains the control plane for scope,
identity, port publication, host reachability, and optional logical resource
isolation through protocol adapters.

## Non-goals

WorkTrellis is not:

- a general workflow or task engine;
- a production process supervisor;
- a schema-migration framework;
- a database-dump transport or sanitization system;
- a secret manager;
- a replacement for Compose, Turborepo, Nx, or package scripts; or
- a registry of TypeScript service implementations for every container a
  project might use.

Foreground process dependencies exist only to start local application
processes safely and stop their complete process trees.

## Knowledge boundary

| Component | WorkTrellis knowledge |
| --- | --- |
| PostGIS | PostgreSQL protocol adapter only |
| PgAdmin | Named host port |
| Gotenberg | Named host port |
| MSSQL per worktree | Named port and workspace scope |
| Shared MSSQL | Optional MSSQL database adapter |
| Arbitrary new container | Compose file only |

Protocol adapters never embed or select Compose images. Copyable recipes may
live in examples, but recipes are not part of the runtime architecture.

## Test

For every proposed feature, ask:

> Does this coordinate or isolate Git worktrees?

If not, it belongs in Compose, a project script, the application, or a
dedicated tool.
