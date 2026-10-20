import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  BootstrapHooks,
  WorkspaceIdentity,
} from "../src/types";

const postgresState = vi.hoisted(() => ({
  databaseExists: false,
  provenanceExists: false,
  isTemplate: false,
  openConnections: 0,
  provenanceRows: [] as Array<{ slug: string; project: string }>,
  queries: [] as string[],
}));

vi.mock("pg", () => {
  class Client {
    async connect() {}

    async query(text: string) {
      postgresState.queries.push(text);

      if (text.includes("pg_database_size")) {
        return {
          rows: postgresState.databaseExists
            ? [{ bytes: "1048576", is_template: postgresState.isTemplate }]
            : [],
        };
      }
      if (text.includes("count(*)::text as open")) {
        return { rows: [{ open: String(postgresState.openConnections) }] };
      }
      if (text.includes("select slug, project from _worktrellis_workspace")) {
        return { rows: postgresState.provenanceRows };
      }
      if (text.includes("from pg_database")) {
        return { rows: postgresState.databaseExists ? [{ one: 1 }] : [] };
      }
      if (text.includes("to_regclass")) {
        return { rows: [{ exists: postgresState.provenanceExists }] };
      }
      if (/create database/i.test(text)) {
        postgresState.databaseExists = true;
      }
      if (/drop database/i.test(text)) {
        postgresState.databaseExists = false;
      }
      if (text.includes("create table if not exists _worktrellis_workspace")) {
        postgresState.provenanceExists = true;
      }

      return { rows: [] };
    }

    async end() {}
  }

  return { Client, default: { Client } };
});

import {
  deprovisionWorkspaceDatabase,
  ensureWorkspaceDatabase,
} from "../src/resources/postgres";

const identity: WorkspaceIdentity = {
  root: "/worktrees/example",
  repoKey: "repo-key",
  isLinkedWorktree: true,
  branch: "feature/test",
  head: "abc123",
  project: "test",
  slug: "test-deadbeef",
  fingerprint: "deadbeef",
  ports: { app: 3000 },
};

function options(hooks: BootstrapHooks) {
  return {
    identity,
    databaseUrl:
      "postgresql://postgres:postgres@127.0.0.1:5432/test_test_deadbeef",
    env: {},
    projectRoot: process.cwd(),
    hooks,
  };
}

beforeEach(() => {
  postgresState.databaseExists = false;
  postgresState.provenanceExists = false;
  postgresState.isTemplate = false;
  postgresState.openConnections = 0;
  postgresState.provenanceRows = [];
  postgresState.queries.length = 0;
});

describe("WorkTrellis database bootstrap recovery", () => {
  it("retries setup when a database exists without completed provenance", async () => {
    postgresState.databaseExists = true;
    const migrate = vi.fn(async () => {});

    const result = await ensureWorkspaceDatabase(
      options({ resource: "database", migrate }),
    );

    expect(migrate).toHaveBeenCalledOnce();
    expect(result.migrated).toBe(true);
    expect(postgresState.provenanceExists).toBe(true);
  });

  it("removes a newly created database when initial migration fails", async () => {
    const failure = new Error("migration failed");

    await expect(
      ensureWorkspaceDatabase(
        options({
          resource: "database",
          migrate: async () => {
            throw failure;
          },
        }),
      ),
    ).rejects.toBe(failure);

    expect(
      postgresState.queries.some((query) => /drop database/i.test(query)),
    ).toBe(true);
    expect(postgresState.databaseExists).toBe(false);
    expect(postgresState.provenanceExists).toBe(false);
  });
});

describe("WorkTrellis database pruning", () => {
  const prune = (dryRun: boolean) =>
    deprovisionWorkspaceDatabase({
      databaseUrl:
        "postgresql://postgres:postgres@127.0.0.1:5432/test_test_deadbeef",
      name: "test_test_deadbeef",
      project: "test",
      slug: "test-deadbeef",
      dryRun,
    });
  const dropped = () =>
    postgresState.queries.some((query) => /drop database/i.test(query));

  it("reports an absent database without dropping anything", async () => {
    await expect(prune(false)).resolves.toEqual({ status: "absent" });
    expect(dropped()).toBe(false);
  });

  it("previews a drop and sizes it without changing the database", async () => {
    postgresState.databaseExists = true;
    postgresState.provenanceExists = true;
    postgresState.provenanceRows = [{ slug: "test-deadbeef", project: "test" }];

    await expect(prune(true)).resolves.toEqual({
      status: "would-remove",
      bytes: 1_048_576,
    });
    expect(dropped()).toBe(false);
    expect(postgresState.databaseExists).toBe(true);
  });

  it("drops a database whose provenance names this workspace", async () => {
    postgresState.databaseExists = true;
    postgresState.provenanceExists = true;
    postgresState.provenanceRows = [
      { slug: "source-cafebabe", project: "test" },
      { slug: "test-deadbeef", project: "test" },
    ];

    await expect(prune(false)).resolves.toEqual({
      status: "removed",
      bytes: 1_048_576,
    });
    expect(postgresState.databaseExists).toBe(false);
  });

  it("drops an adapter-only database matched by its derived name", async () => {
    postgresState.databaseExists = true;

    await expect(prune(false)).resolves.toEqual(
      expect.objectContaining({ status: "removed", detail: expect.stringMatching(/derived name/) }),
    );
  });

  it("keeps templates, open databases, and databases owned elsewhere", async () => {
    postgresState.databaseExists = true;

    postgresState.isTemplate = true;
    await expect(prune(false)).resolves.toEqual(
      expect.objectContaining({ status: "refused", detail: expect.stringMatching(/template/) }),
    );

    postgresState.isTemplate = false;
    postgresState.openConnections = 2;
    await expect(prune(false)).resolves.toEqual(
      expect.objectContaining({ status: "refused", detail: "2 open connection(s)" }),
    );

    postgresState.openConnections = 0;
    postgresState.provenanceExists = true;
    postgresState.provenanceRows = [{ slug: "other-cafebabe", project: "test" }];
    await expect(prune(false)).resolves.toEqual(
      expect.objectContaining({ status: "refused", detail: expect.stringMatching(/different workspace/) }),
    );

    expect(dropped()).toBe(false);
    expect(
      postgresState.queries.some((query) => query.includes("pg_terminate_backend")),
    ).toBe(false);
  });
});
