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

Starts shared services when needed, provisions this worktree's resources,
writes `.worktrellis/env`, and supervises configured processes.

```text
--only <names>      Start only comma-separated process names
--no-services       Do not start shared services
--direct            Force a localhost port instead of portless
--portless          Require a portless hostname
--migrate           Run the configured migration hook
--seed[=<name>]     Run the default or named seed hook
--no-prefix         Do not prefix child output with process names
```

### `worktrellis down`

Stops processes recorded for this worktree and releases its portless aliases.
Shared containers remain running.

### `worktrellis status`

Reports the worktree URL, supervised-process state, and shared-service health.
Supports `--json`.

### `worktrellis doctor`

Checks Node, Git, the container engine, service reachability, environment
conflicts, generated-snapshot consumption, and project-defined doctor checks.
Supports `--json`.

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

## Shared services

```text
worktrellis services up
worktrellis services down [--volumes]
worktrellis services restart
worktrellis services status
worktrellis services logs [service] [--tail <n>] [--follow]
worktrellis services adopt --postgres-port <port>
```

`down` retains data volumes unless `--volumes` is explicitly supplied.
`adopt` records a machine-local port override without changing project
configuration.

## Database

```text
worktrellis db url
worktrellis db migrate
worktrellis db seed [--seed <name>]
worktrellis db reset
```

`reset` is destructive and is limited to the database WorkTrellis derived for
the current worktree.

## Introspection

### `worktrellis info`

Prints the current worktree identity and derived resource names.

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
