# Responsibility boundaries

## Contents

- Ownership matrix
- Decision tests
- URL and Tailscale boundary
- Adapter boundary
- Environment boundary
- Lifecycle boundary

## Ownership matrix

| Concern | Owner |
| --- | --- |
| Git repository and worktree identity | WorkTrellis |
| Deterministic app and named host ports | WorkTrellis |
| Machine, repository, and workspace scope | WorkTrellis |
| Logical database, namespace, or bucket isolation | WorkTrellis adapters |
| Generated per-worktree environment | WorkTrellis |
| Foreground local process supervision | WorkTrellis |
| Services, images, networks, volumes, builds | Project Compose |
| Container health checks | Project Compose |
| Package scripts and task pipelines | Project |
| Schema migrations and seeds | Project hooks and tools |
| Dump acquisition, sanitation, and restore logic | Project |
| Secrets | Developer, environment, or secret manager |
| Local hostnames, proxy, routes, certificates | Portless |
| Tailscale Serve and remote URL | Portless |
| Production deployment and process management | Deployment platform |

## Decision tests

Before adding behavior, ask:

1. Does it coordinate or isolate local Git working trees?
2. Is the behavior independent of a specific application or image?
3. Can it be expressed as project Compose or a project script instead?
4. Does it require secret persistence?
5. Does it duplicate a URL provider or container engine?
6. Does a read-only command remain read-only after the change?

If the answer to the first question is no, keep the behavior outside
WorkTrellis.

## URL and Tailscale boundary

WorkTrellis may:

- choose `auto`, `direct`, or `portless`;
- derive a worktree-safe application name;
- assign the app port;
- invoke Portless through its public interface;
- supervise the foreground Portless wrapper; and
- expose the returned URL in the generated environment.

WorkTrellis must not:

- edit Portless route registries;
- inspect Portless private state or certificate files;
- generate or trust certificates;
- call `tailscale serve` directly;
- choose the remote Tailscale HTTPS port;
- derive a tailnet URL;
- repair unrelated Tailscale Serve state; or
- create its own proxy or tunnel.

Tailscale is a Portless mode, not a third WorkTrellis routing subsystem.

## Adapter boundary

An adapter knows a protocol and a logical isolation unit. It may provision a
database, namespace, bucket, index, or similar unit inside an endpoint.

An adapter must not:

- select or embed a Compose image;
- define container networks or volumes;
- carry application-specific migration logic;
- invent credentials;
- own dump policy; or
- become a general plugin runtime.

Endpoint-only services need no adapter. Services without a logical isolation
mechanism should use a workspace-scoped Compose stack.

## Environment boundary

The project owns `.env`. WorkTrellis reads it and never modifies it.

WorkTrellis owns `.worktrellis/env`, which is generated, ignored, and never
hand-edited. Developers own personal ignored choices in
`.worktrellis/local.json`. Machine-wide coordination belongs under the
WorkTrellis home directory.

Diagnostics must redact secret-looking values. An explicit command that asks
for one resolved value may print it by contract, so use such commands
carefully.

## Lifecycle boundary

WorkTrellis supervises foreground local-development processes. It should:

- track verified process identity;
- request cooperative shutdown first;
- give wrappers time to clean up;
- force-stop only after a bounded grace period;
- detect orphaned children and occupied app ports; and
- fail rather than falsely report a clean stop.

WorkTrellis does not own production daemons or arbitrary machine processes.
Never kill a process based only on a stale numeric PID or an unverified port.
