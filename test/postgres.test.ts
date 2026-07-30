import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  BootstrapHooks,
  WorkspaceIdentity,
} from "../src/types";

const postgresState = vi.hoisted(() => ({
  databaseExists: false,
  provenanceExists: false,
  queries: [] as string[],
}));

vi.mock("pg", () => {
  class Client {
    async connect() {}

    async query(text: string) {
      postgresState.queries.push(text);

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
      if (text.includes("create table if not exists _devstack_workspace")) {
        postgresState.provenanceExists = true;
      }

      return { rows: [] };
    }

    async end() {}
  }

  return { Client, default: { Client } };
});

import {
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
  databaseName: "test_test_deadbeef",
  bucketName: "test-test-deadbeef",
  redisPrefix: "test:test-deadbeef",
  redisDb: 1,
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
  postgresState.queries.length = 0;
});

describe("WorkTrellis database bootstrap recovery", () => {
  it("retries setup when a database exists without completed provenance", async () => {
    postgresState.databaseExists = true;
    const migrate = vi.fn(async () => {});

    const result = await ensureWorkspaceDatabase(
      options({ migrate }),
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
