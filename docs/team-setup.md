# Team adoption

## Commit to the project

Each repository using WorkTrellis should commit:

- `worktrellis` as a development dependency;
- `worktrellis.config.ts`;
- package scripts that call `worktrellis`;
- `/.worktrellis/` in `.gitignore`;
- an `.env.example` containing secrets and optional overrides only.

Do not commit `.worktrellis/env`, machine port overrides, database dumps, or
real secrets.

Developers may create `.worktrellis/local.json` for explicitly local choices
such as a short Portless hostname. It remains ignored with the rest of the
directory and must not be required for the committed project configuration to
work.

## Recommended package scripts

```json
{
  "scripts": {
    "dev": "worktrellis up",
    "dev:direct": "worktrellis up --direct",
    "dev:app": "worktrellis up --only app",
    "services:up": "worktrellis services up",
    "services:status": "worktrellis services status",
    "worktrellis:doctor": "worktrellis doctor",
    "worktrellis:env": "worktrellis env --explain"
  }
}
```

## New developer checklist

```bash
git clone <repository>
cd <repository>
cp .env.example .env
pnpm install
pnpm worktrellis:doctor
pnpm dev
```

The first start may download container images and build a database template.
Subsequent worktrees reuse compatible machine/repository stacks and matching
database templates.

## Pin the package

Commit the lockfile and use an explicit compatible range. Before 1.0, prefer an
exact version so the team upgrades intentionally:

```json
{
  "devDependencies": {
    "worktrellis": "0.4.0"
  }
}
```

When upgrading:

1. read the changelog;
2. update the dependency in one branch;
3. migrate `worktrellis.config.ts` if the config version changed;
4. run `worktrellis doctor` and `worktrellis self-check`;
5. start two worktrees concurrently;
6. verify their database, Redis prefix, bucket, URL, and process-port identities
   differ while intended shared stacks have the same Compose project identity.

## Database dumps

Commit a project-owned restore script that:

- reads `DATABASE_URL` from the environment;
- refuses non-local or unexpected database names;
- validates the dump source and format;
- restores or normalizes application-specific data; and
- documents whether the data is sanitized.

Run it with:

```bash
worktrellis run db:restore -- /path/to/dump
```

Do not put production credentials or production-download behavior in the
shared WorkTrellis package.

## Team configuration policy

Treat `worktrellis.config.ts`, project Compose files, restore scripts, and the
lockfile as reviewed source code. Keep machine-specific choices in
`~/.worktrellis/machine.json`, normally through `worktrellis services adopt`.
Keep worktree-specific choices in `.worktrellis/local.json`.

Choose the narrowest useful Compose scope:

- use `machine` for compatible shared infrastructure such as a project's
  PostgreSQL/Redis/object-storage stack;
- use `repository` when one project needs a shared custom dependency;
- use `workspace` when a service cannot logically isolate concurrent
  worktrees.

Changing or stopping a shared stack can affect other running worktrees. Check
`worktrellis services status` and `worktrellis services variants` before
planned maintenance. Upgrade every active worktree to 0.4 or newer before
reconciling a legacy lineage; older clients do not understand lineage
selection.
