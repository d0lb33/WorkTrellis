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
Subsequent worktrees reuse the shared services and matching template.

## Pin the package

Commit the lockfile and use an explicit compatible range. Before 1.0, prefer an
exact version so the team upgrades intentionally:

```json
{
  "devDependencies": {
    "worktrellis": "0.1.0"
  }
}
```

When upgrading:

1. read the changelog;
2. update the dependency in one branch;
3. run `worktrellis doctor` and `worktrellis self-check`;
4. start two worktrees concurrently;
5. verify their database, Redis, bucket, URL, and port identities differ.

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
