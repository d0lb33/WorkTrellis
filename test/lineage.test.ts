import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ComposeStackSpec, WorkspaceIdentity } from "../src/types";
import { renderStack } from "../src/platform/compose-render";
import { ComposeStack } from "../src/platform/compose";
import {
  clearMachineRunLease,
  consumersForProject,
  readLineageRegistry,
  replaceProjectLineageSelection,
  selectedLineage,
  writeLineageSelection,
  writeMachineRunLease,
} from "../src/platform/lineage-state";
import { retainedConflicts, type MachineVariant } from "../src/platform/lineage";

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(name: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  temporaryDirectories.push(directory);
  return directory;
}

function identity(root: string): WorkspaceIdentity {
  return {
    root,
    repoKey: "repo12345678",
    isLinkedWorktree: false,
    branch: "main",
    head: "abc123",
    project: "example",
    slug: "main-deadbeef",
    fingerprint: "deadbeef",
    ports: { app: 3000 },
  };
}

function stackSpec(
  volumeDataVersions?: Record<string, string>,
): ComposeStackSpec {
  return {
    name: "infrastructure",
    scope: "machine",
    files: ["compose.yml"],
    ports: {
      database: { service: "postgres", containerPort: 5432 },
    },
    volumeDataVersions,
  };
}

describe("machine stack lineages", () => {
  it("reports a never-rendered desired lineage as stopped without spawning Compose", async () => {
    const root = temporaryDirectory("worktrellis-missing-lineage");
    const home = temporaryDirectory("worktrellis-missing-lineage-home");
    vi.stubEnv("WORKTRELLIS_HOME", home);
    fs.writeFileSync(
      path.join(root, "compose.yml"),
      "services:\n  postgres:\n    image: postgres:16-alpine\n",
    );
    const rendered = renderStack({
      spec: stackSpec(),
      projectRoot: root,
      identity: identity(root),
    });
    const stack = new ComposeStack(
      {
        name: "docker",
        cli: "/definitely/missing/docker",
        compose: ["/definitely/missing/docker", "compose"],
      },
      rendered,
    );
    await expect(stack.ps()).resolves.toEqual([]);
  });

  it("keeps pre-0.4 compatibility identities when no data versions are declared", () => {
    const root = temporaryDirectory("worktrellis-lineage-render");
    fs.writeFileSync(
      path.join(root, "compose.yml"),
      "services:\n  postgres:\n    image: postgres:16-alpine\n",
    );
    const absent = renderStack({
      spec: stackSpec(),
      projectRoot: root,
      identity: identity(root),
    });
    const empty = renderStack({
      spec: stackSpec({}),
      projectRoot: root,
      identity: identity(root),
    });
    expect(empty.compatibilityId).toBe(absent.compatibilityId);
  });

  it("changes compatibility identity when a volume data generation changes", () => {
    const root = temporaryDirectory("worktrellis-lineage-version");
    fs.writeFileSync(
      path.join(root, "compose.yml"),
      "services:\n  postgres:\n    image: postgres:16-alpine\nvolumes:\n  postgres_data:\n",
    );
    const postgres16 = renderStack({
      spec: stackSpec({ postgres_data: "postgres-16" }),
      projectRoot: root,
      identity: identity(root),
    });
    const postgres17 = renderStack({
      spec: stackSpec({ postgres_data: "postgres-17" }),
      projectRoot: root,
      identity: identity(root),
    });
    expect(postgres17.compatibilityId).not.toBe(postgres16.compatibilityId);
  });

  it("persists an explicit physical lineage selection atomically", () => {
    const home = temporaryDirectory("worktrellis-lineage-home");
    vi.stubEnv("WORKTRELLIS_HOME", home);
    writeLineageSelection({
      compatibilityId: "worktrellis-machine-infrastructure-new00000",
      projectName: "worktrellis-machine-infrastructure-old00000",
      ports: { database: 15432 },
      selectedAt: "2026-08-01T00:00:00.000Z",
    });
    expect(readLineageRegistry().version).toBe(1);
    expect(
      selectedLineage("worktrellis-machine-infrastructure-new00000"),
    ).toMatchObject({
      projectName: "worktrellis-machine-infrastructure-old00000",
      ports: { database: 15432 },
    });
  });

  it("moves a physical lineage to one compatibility identity", () => {
    const home = temporaryDirectory("worktrellis-lineage-replace");
    vi.stubEnv("WORKTRELLIS_HOME", home);
    writeLineageSelection({
      compatibilityId: "old-definition",
      projectName: "physical-lineage",
      ports: { database: 15432 },
      selectedAt: "2026-08-01T00:00:00.000Z",
    });
    replaceProjectLineageSelection({
      compatibilityId: "new-definition",
      projectName: "physical-lineage",
      ports: { database: 15432 },
      selectedAt: "2026-08-01T01:00:00.000Z",
    });
    expect(selectedLineage("old-definition")).toBeNull();
    expect(selectedLineage("new-definition")?.projectName).toBe(
      "physical-lineage",
    );
  });

  it("does not report a conflict once the desired physical lineage is retained", () => {
    const rendered = {
      stackId: "worktrellis-machine-infrastructure-current1",
    } as ReturnType<typeof renderStack>;
    const variants: MachineVariant[] = [
      {
        projectName: rendered.stackId,
        running: false,
        retained: true,
        volumes: ["current_data"],
        createdAt: null,
        compatibility: "current",
        selected: true,
        consumers: [],
      },
      {
        projectName: "worktrellis-machine-infrastructure-previous",
        running: true,
        retained: true,
        volumes: ["previous_data"],
        createdAt: null,
        compatibility: "different",
        selected: false,
        consumers: [],
      },
    ];
    expect(retainedConflicts(rendered, variants)).toEqual([]);
  });

  it("records and verifies live machine consumers without exposing environment", () => {
    const home = temporaryDirectory("worktrellis-lease-home");
    vi.stubEnv("WORKTRELLIS_HOME", home);
    const root = process.cwd();
    writeMachineRunLease({
      version: 1,
      pid: process.pid,
      startedAtMs: Date.now() - process.uptime() * 1_000,
      project: "example",
      repoKey: "repo12345678",
      slug: "main-deadbeef",
      branch: "main",
      worktreeRoot: root,
      stacks: [
        {
          name: "infrastructure",
          compatibilityId: "desired",
          projectName: "physical",
        },
      ],
    });
    expect(consumersForProject("physical")).toEqual([
      expect.objectContaining({
        project: "example",
        slug: "main-deadbeef",
        state: "live",
      }),
    ]);
    clearMachineRunLease("repo12345678", "main-deadbeef");
    expect(consumersForProject("physical")).toEqual([]);
  });
});
