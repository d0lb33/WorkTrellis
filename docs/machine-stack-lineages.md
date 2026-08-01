# Machine-stack lineages

A machine stack has two identities:

- the compatibility identity derived from its project-owned Compose contents,
  named ports, explicit Compose environment, and volume data generations; and
- the physical Compose project that owns its containers, ports, and volumes.

They are normally the same. Reconciliation intentionally maps a new compatible
definition onto an existing physical project so local data remains continuous.
The mapping is machine-local under `WORKTRELLIS_HOME` and is never committed.

## When a definition changes

In an interactive terminal, `worktrellis up` lists retained variants and offers
to reconcile a proven-compatible lineage, start a fresh variant, or cancel.
Enter cancels. In CI and other non-interactive environments, the command exits
with code 4 before changing infrastructure.

Use explicit commands when coordinating a team or automation:

```bash
worktrellis services variants infrastructure
worktrellis services reconcile infrastructure \
  --from worktrellis-machine-infrastructure-deadbeef
worktrellis up --new-variant infrastructure
```

Reconciliation blocks while any verified worktree uses the source or target.
It stops containers without deleting volumes, applies the new definition,
waits for health, and restores the old definition if startup fails.

Upgrade or stop every consumer before the first reconciliation. Pre-0.4
clients do not write machine-global leases and cannot follow a selected
physical lineage, so mixed-version consumers are unsupported.

## Stateful compatibility

Without project metadata, WorkTrellis requires identical persistent mounts,
resolved images, commands, entrypoints, and configured environment. This makes
tag-to-identical-digest changes safe while refusing changes it cannot prove.

Projects can declare named-volume data generations:

```ts
volumeDataVersions: {
  postgres_data: "postgres-16",
  redis_data: "redis-7",
}
```

An equal generation is an explicit project assertion that reuse is safe.
Changing `postgres-16` to `postgres-17` requests a fresh lineage; use
project-owned dump/restore or migration tooling to populate it. WorkTrellis
does not interpret database formats or copy data between lineages.

All volumes in one Compose project move as a lineage. Put independently
upgraded stateful services in separate machine stacks rather than sharing only
some volumes between concurrently running variants.

## Retention and cleanup

Variants and their volumes are never pruned automatically. Stop an unselected
variant while retaining data with:

```bash
worktrellis services down --variant <compose-project>
```

Add `--volumes` only after verifying that its data is no longer needed. This is
the sole destructive variant-cleanup path.
