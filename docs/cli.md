# CLI reference

## Global options

```text
--cwd <dir>       Resolve the project as if invoked from this directory
--config <file>   Use an explicit configuration file
--json            Machine-readable output where supported
--no-color        Disable ANSI color
-q, --quiet       Print only errors
-v, --version     Print the installed version
-h, --help        Print help
```

Commands search the current directory and its parents for
`worktrellis.config.ts` unless `--config` is supplied.

## Workspace lifecycle

### `worktrellis up`

Starts configured Compose stacks when needed, provisions this worktree's resources,
writes `.worktrellis/env`, and supervises configured processes.

```text
--only <names>      Start only comma-separated process names
--no-services       Do not start stopped Compose stacks
--direct            Force a localhost port instead of portless
--portless          Require a portless hostname
--tailscale         Ask Portless to share the app on your tailnet
--migrate           Run the configured migration hook
--seed[=<name>]     Run the default or named seed hook
--no-prefix         Do not prefix child output with process names
```

An explicit `--tailscale` request fails if Portless sharing cannot be started;
it never silently falls back to a loopback-only URL.
Portless chooses the private HTTPS port dynamically when multiple apps are
shared. The exact provider-returned URL is retained for the live run and shown
by `worktrellis status`.

### `worktrellis down`

Stops processes recorded for this worktree. Portless removes its local and
private routes as the wrapped app exits. WorkTrellis first requests a
cooperative supervisor shutdown, preserving the wrapper while stopping its
owned application tree on Windows, then force-reaps only verified leftovers
after a timeout. It returns a failing exit code instead of reporting success
when a managed process or the application port remains alive. Compose stacks
remain running.

If a wrapper exited before WorkTrellis could retain its run record, `down`
still detects the expected application port. Run `worktrellis down --force` to
authorize recovery from that lost-state case. WorkTrellis identifies the
listener, walks to the highest live ancestor whose command line belongs to the
current worktree, and refuses to signal the tree when ownership cannot be
verified.

On Windows, supervised application wrappers start without a console and are
assigned to a parent-owned Job Object before their first instruction runs.
No additional Command Prompt windows are opened. The npm command remains
attached until port verification and any required descendant cleanup finish.
WorkTrellis first preserves the cooperative wrapper-cleanup window; forced
shutdown terminates the complete Job Object. If WorkTrellis itself exits
abruptly, closing its Job handle terminates the payload and descendants. A
launch fails instead of falling back to weak supervision when this lifecycle
cannot be established. After a normal single-Ctrl+C shutdown, returning to the
shell prompt therefore means cleanup has completed.

### `worktrellis status`

Reports the worktree URL, supervised-process state, Compose health, and
resolved resource names. If the supervisor is gone while a recorded child or
application listener remains, status reports `orphaned` and exits with a
failing status instead of describing the workspace as stopped.
The deterministic application port is probed even when the live run record is
missing.
For a live Tailscale-backed run, human output includes `tailnet` and JSON output
includes `url.sharingUrl`.
Supports `--json`. Structured status omits the worktree root and provider
environment, reports resources as safe descriptions, and redacts credentials
from diagnostic details.

### `worktrellis doctor`

Checks Node, Git, the expected application port, the container engine, stack
reachability, environment conflicts, generated-snapshot consumption, and
project-defined doctor checks. A held application port without a live
WorkTrellis supervisor is a failing check with a safe recovery hint. It warns
when `worktrellis prune` would select deleted or idle worktrees, without
connecting to their resources. Supports `--json`.

## Environment

### `worktrellis env`

Resolves the effective environment.

```text
--explain       Show the source of every value
--json          Print structured output
--print <key>   Print one value without decoration
--direct        Resolve using the direct URL provider
```

Secret-looking values are redacted in human-readable output.

### `worktrellis exec -- <command> [args...]`

Runs an executable directly with the resolved worktree environment. There is no
implicit shell, so pipes, redirects, variable expansion, and compound commands
belong in a checked-in project script.

### `worktrellis run <script> [args...]`

Runs a package-manager script with the resolved worktree environment. The
manager comes from `packageManager` in the host project's `package.json`, then
the invoking package manager, with pnpm as the final default.

## Compose infrastructure

```text
worktrellis services up
worktrellis services down [--volumes]
worktrellis services restart
worktrellis services status
worktrellis services logs [stack] [--tail <n>] [--follow]
worktrellis services variants [stack] [--json]
worktrellis services reconcile <stack> --from <compose-project>
worktrellis services down --variant <compose-project> [--volumes]
worktrellis services adopt --postgres-port <port>
worktrellis services adopt --local.postgres-port <port>
worktrellis services endpoint [show]
worktrellis services endpoint set --bind-address <ip> --connect-host <host>
worktrellis services endpoint clear
```

`down` affects every stack declared by the current project and retains data
volumes unless `--volumes` is explicitly supplied. For machine- or
repository-scoped stacks, that can affect other active worktrees. `logs`
defaults to the first declared stack.

`variants` lists selected and retained machine lineages without exposing secret
values or host volume paths. `reconcile` preserves the selected physical
project, host ports, and named volumes after verifying stateful compatibility
and active consumers. Use `up --new-variant <stack>` to explicitly create fresh
volumes instead. There is no force-reconcile option.

`adopt` records a machine-local port override without changing project
configuration. An unqualified name such as `postgres` applies wherever that
named port is used; `<stack>.<port>` scopes the override to one configured
stack.

`endpoint` shows or changes the machine-local publication and connection
addresses for the active Docker context. `set` requires both addresses and
records a fingerprint of the context endpoint so a later context change cannot
silently reuse stale network settings. Non-loopback publication is explicit;
wildcard addresses produce an exposure warning. Docker context selection,
virtual-machine networking, firewalls, DNS, and tunnels are outside this
command's contract.

## Database

```text
worktrellis db url
worktrellis db migrate
worktrellis db seed [--seed <name>]
worktrellis db reset
```

`reset` is destructive and is limited to the database WorkTrellis derived for
the current worktree.

## Maintenance

### `worktrellis prune`

```text
worktrellis prune [--yes] [--max-idle-days <n>] [--json]
```

Reports what deleted worktrees of the current project still hold, and with
`--yes` removes it. Without `--yes` nothing changes. Run it from any checkout
of the project; it uses that checkout's configuration, credentials, and
Compose endpoints.

A recorded worktree is selected when:

- its path is gone but an ancestor directory still exists. A path whose
  nearest surviving ancestor is a filesystem root or a mount root such as
  `/Volumes` is reported as unavailable instead, so an unmounted drive never
  makes its worktrees prunable; or
- it still exists but its workspace record was last refreshed more than
  `--max-idle-days` days ago, or `gc.maxIdleDays` when the flag is absent.

A worktree whose recorded supervisor is live, or cannot be verified as
stopped, is never selected, and the current worktree never is.

For each selected worktree, `prune --yes`:

- calls each resource adapter's `deprovision` hook. `postgresDatabase()` drops
  the database WorkTrellis derived for that worktree, but keeps it when it is a
  template, has open connections, or its provenance names another workspace.
  No session is terminated. `s3Bucket()` empties and deletes the derived
  bucket and refuses a versioned bucket. `redisNamespace()` and adapters
  without the hook are reported as retained;
- removes the worktree's workspace-scoped Compose projects with their
  containers, networks, and named volumes; and
- removes its run lease, logs, and workspace record. The record is kept, so a
  later prune can retry, while any resource is refused, failed, unreachable,
  or still provisioned in another existing Compose project.

It also removes stale run leases of the project, and machine-stack definition
directories and lineage selections of the project's stacks that no container,
volume, or live supervisor uses. Shared stacks are never started, stopped, or
emptied, and retained variant volumes stay under
`services down --variant --volumes`.

A dry run exits `0`. With `--yes`, the exit code is `1` when any selected
worktree kept its record.

## Introspection

### `worktrellis info`

Prints the current worktree identity, exact derived Docker Compose project
names and scopes, and foreground-process ports. The Compose names are the
projects under which Docker groups service containers; configured application
processes run on the host under WorkTrellis supervision.

### `worktrellis list`

Lists all worktrees known to this machine. Use `--project <name>` to filter and
`--json` for structured output.

### `worktrellis url`

Prints the current worktree URL. `--tenant <subdomain>` applies the configured
tenant URL template. Supports `--json`.

### `worktrellis self-check`

Checks that the WorkTrellis package source has not imported host-project code
or vocabulary. This is primarily a package-development command.

## Exit codes

| Code | Meaning |
| ---: | --- |
| `0` | Success |
| `1` | Check or health failure |
| `2` | Invalid CLI usage |
| `3` | Missing environment requirement |
| `4` | Resource conflict |
| `5` | Supervised child process failure |
