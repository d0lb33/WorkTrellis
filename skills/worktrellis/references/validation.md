# Validation workflow

## Contents

- Safety rules
- Static checks
- Read-only diagnostics
- Runtime validation
- Machine-lineage validation
- Two-worktree validation
- Phone-access validation
- Completion evidence

## Safety rules

- Preserve unrelated changes.
- Never print secret values.
- Do not use `db reset`, `services down --volumes`, or other destructive
  commands merely as a test.
- Check shared-stack users before stopping machine- or repository-scoped
  services.
- Use the project's package manager and local WorkTrellis executable.
- Stop only processes started for the validation, and verify cleanup.

## Static checks

Before starting services:

1. validate TypeScript or JavaScript syntax;
2. run the project's typecheck and relevant tests;
3. inspect the Compose merged configuration if the container CLI supports it;
4. ensure every declared stack and port reference exists;
5. ensure WorkTrellis-owned host ports are absent from project Compose;
6. ensure `.worktrellis/` is ignored;
7. ensure `.env` is unchanged and untracked secrets are not staged;
8. check for recursive package scripts; and
9. verify exactly one normal app process binds the app port; and
10. compare the manifest dependency, lockfile resolution, resolved package
    path and version, and `worktrellis --version`.

Fail the validation when a local link or symlink is the only reason the
configuration version works. A clean install must select a compatible package.

## Read-only diagnostics

Run:

```bash
worktrellis doctor
worktrellis info
worktrellis env --explain
worktrellis services status
worktrellis services variants
worktrellis status
```

Use `--json` when programmatic assertions help. Treat all resolved environment
output, including `env --explain`, as sensitive local-only output even when
secret-looking values are expected to be redacted. Do not paste it into issues,
logs, or reports. `status --json` is designed to omit the worktree root and
provider environment and to describe resources safely.

Confirm:

- the expected repository and worktree identity;
- the intended Compose project names and scopes;
- deterministic app and process ports;
- distinct logical resource names;
- no critical generated value is shadowed by `.env`;
- required tools and daemons are reachable; and
- stopped, running, or orphaned state is truthful.

For every machine-scoped stack, confirm the selected physical lineage,
compatibility identity, retained variants, safe volume names, and verified
consumers. Read-only commands must not rewrite definitions or start, stop, or
repoint infrastructure.

## Runtime validation

Start with:

```bash
worktrellis up
```

Verify:

- all required Compose services become reachable;
- resource provisioning succeeds idempotently;
- the generated environment reaches each child process;
- the app opens at the reported URL;
- workers remain healthy;
- readiness completes within the configured timeout; and
- a second resource-resolution pass returns stable identities.

Then stop:

```bash
worktrellis down
worktrellis status
```

Confirm no managed child or application listener remains. Compose stacks
normally remain running.

Also test direct mode when Portless is configured:

```bash
worktrellis up --direct
worktrellis down
```

The app must honor the deterministic direct host and port.

Before stopping a machine- or repository-scoped stack, enumerate known
worktrees with `worktrellis list --project <project>`, inspect
`worktrellis services status`, and run
`worktrellis services variants <stack>`. Check every verified consumer before
proceeding. There is no safe assumption that the current checkout is the only
consumer.

When validating a machine-definition change:

1. Preserve sentinel data or create a project-owned verified backup when the
   user authorized it.
2. Confirm non-interactive unresolved conflicts exit with code `4` before new
   stack files, ports, containers, or volumes are created.
3. Reconcile only a reported compatible candidate with
   `worktrellis services reconcile <stack> --from <compose-project>`.
4. Use `--new-variant <stack>` to test intentional isolation.
5. Confirm old volume IDs and sentinel data survive reconciliation or fresh
   selection, and that no variant is implicitly removed.

## Two-worktree validation

Run this when identity, naming, scopes, ports, resources, or generated
environment changed.

Use one normal checkout and one real linked Git worktree. Do not fake worktree
paths. In each:

1. install dependencies as the project expects;
2. run `worktrellis info --json`;
3. run `worktrellis env --json`;
4. start the environment;
5. verify the app is reachable; and
6. record only non-secret identities needed for comparison.

Assert:

- workspace fingerprints, slugs, app ports, and URLs differ;
- workspace-scoped Compose project names differ;
- repository-scoped project names match only inside the same repository;
- compatible worktrees select the same physical machine lineage;
- an intentional fresh variant selects a different physical lineage while the
  retained lineage and its volumes remain discoverable;
- PostgreSQL database names differ;
- Redis prefixes differ, and logical databases follow configured behavior;
- S3 bucket names differ; and
- stopping one workspace does not stop or repoint the other.

If Git, Docker, Compose, or the daemon is unavailable, report the exact
prerequisite and skip only the dependent test. Once prerequisites pass,
startup, isolation, reachability, and cleanup failures are real failures.

## Phone-access validation

Only run when the user requests private device access and has working
Tailscale and Portless setup:

```bash
worktrellis up --tailscale
```

Use Portless 0.15.5 or newer and the exact URL printed by Portless or reported
as `tailnet` by `worktrellis status`. Verify the phone is on the same tailnet and
the application accepts the remote origin. Authentication systems may require
their public/base URL and trusted-origin settings to derive from
WorkTrellis-provided URL values.

Do not manually configure `tailscale serve` as part of WorkTrellis validation.
After shutdown, verify Portless removes the route it created.

## Completion evidence

Report:

- exact commands and results;
- runtime URL without secret query parameters;
- the selected stack scopes;
- resource isolation comparisons;
- whether direct and Portless modes passed;
- whether Tailscale was intentionally tested;
- graceful skips and their missing prerequisites; and
- any remaining manual setup.
