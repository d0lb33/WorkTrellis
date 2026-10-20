import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { pruneDoctorCheck } from "../src/commands/doctor";
import { formatBytes, resourceLocation } from "../src/commands/prune";
import { loadConfig } from "../src/core/config";
import {
  identityFromRecord,
  resolveMaxIdleDays,
  selectPruneCandidates,
  worktreeAvailability,
  type LeaseState,
  type WorktreeAvailability,
} from "../src/core/gc";
import { buildDatabaseName } from "../src/core/naming";
import type { WorkspaceRecord } from "../src/core/state";
import { planMachineDefinitionCleanup } from "../src/platform/cleanup";
import { isMachineVariantName } from "../src/platform/compose-render";
import type { ComposeInventory } from "../src/platform/lineage";
import {
  workspaceLeaseState,
  writeMachineRunLease,
  type LeaseConsumer,
  type LineageRegistry,
} from "../src/platform/lineage-state";
import { postgresDatabase } from "../src/resources";

const temporaryDirectories: string[] = [];

function temporaryDirectory(label: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const NOW = Date.parse("2026-10-20T12:00:00.000Z");

function record(overrides: Partial<WorkspaceRecord> = {}): WorkspaceRecord {
  return {
    project: "shop",
    slug: "feature-deadbeef",
    repoKey: "repo-one",
    worktreeRoot: "/worktrees/feature",
    branch: "feature",
    hostname: "shop.localhost",
    appUrl: "http://127.0.0.1:3000",
    lastSeenAt: "2026-10-19T12:00:00.000Z",
    createdAt: "2026-10-01T12:00:00.000Z",
    ...overrides,
  };
}

function select(
  records: WorkspaceRecord[],
  options: {
    availability?: Record<string, WorktreeAvailability>;
    leases?: Record<string, LeaseState>;
    maxIdleDays?: number;
  } = {},
) {
  return selectPruneCandidates({
    records,
    project: "shop",
    current: { repoKey: "repo-one", slug: "main-0000beef" },
    maxIdleDays: options.maxIdleDays,
    now: NOW,
    leaseState: (entry) => options.leases?.[entry.slug] ?? "none",
    availability: (root) => options.availability?.[root] ?? "present",
  });
}

describe("WorkTrellis prune selection", () => {
  it("selects deleted worktrees of this project only", () => {
    const deleted = record();
    const selection = select(
      [
        deleted,
        record({ slug: "kept-cafebabe", worktreeRoot: "/worktrees/kept" }),
        record({ project: "other", slug: "other-feedface", worktreeRoot: "/gone/other" }),
        record({ slug: "main-0000beef", worktreeRoot: "/gone/current" }),
      ],
      {
        availability: {
          "/worktrees/feature": "missing",
          "/gone/other": "missing",
          "/gone/current": "missing",
        },
      },
    );

    expect(selection.candidates).toEqual([{ record: deleted, reason: "missing" }]);
    expect(selection.skipped).toEqual([]);
  });

  it("never treats an unmounted or removed parent as a deletion", () => {
    const selection = select([record()], {
      availability: { "/worktrees/feature": "unavailable" },
    });

    expect(selection.candidates).toEqual([]);
    expect(selection.skipped[0]?.reason).toMatch(/cannot be confirmed/);
  });

  it("keeps worktrees whose supervisor is live or unverifiable", () => {
    const live = record({ slug: "live-11111111", worktreeRoot: "/gone/live" });
    const unverified = record({ slug: "odd-22222222", worktreeRoot: "/gone/odd" });
    const stale = record({ slug: "stale-33333333", worktreeRoot: "/gone/stale" });
    const selection = select([live, unverified, stale], {
      availability: {
        "/gone/live": "missing",
        "/gone/odd": "missing",
        "/gone/stale": "missing",
      },
      leases: {
        "live-11111111": "live",
        "odd-22222222": "unverified",
        "stale-33333333": "stale",
      },
    });

    expect(selection.candidates.map((entry) => entry.record.slug)).toEqual([
      "stale-33333333",
    ]);
    expect(selection.skipped.map((entry) => entry.record.slug)).toEqual([
      "live-11111111",
      "odd-22222222",
    ]);
  });

  it("selects idle existing worktrees only when a retention period is set", () => {
    const idle = record({ lastSeenAt: "2026-09-20T12:00:00.000Z" });
    const recent = record({
      slug: "recent-44444444",
      lastSeenAt: "2026-10-18T12:00:00.000Z",
    });
    const unknown = record({ slug: "unknown-55555555", lastSeenAt: "not a date" });

    expect(select([idle, recent, unknown]).candidates).toEqual([]);
    expect(select([idle, recent, unknown], { maxIdleDays: 30 }).candidates).toEqual([
      { record: idle, reason: "idle", idleDays: 30 },
    ]);
    expect(select([idle], { maxIdleDays: 31 }).candidates).toEqual([]);
  });

  it("classifies worktree locations by their nearest surviving ancestor", () => {
    const root = temporaryDirectory("worktrellis-prune-location");
    const present = path.join(root, "present");
    fs.mkdirSync(present);
    const unique = path.basename(root);

    expect(worktreeAvailability(present)).toBe("present");
    expect(worktreeAvailability(path.join(root, "deleted"))).toBe("missing");
    // Tools such as `<tool>/worktrees/<id>/<repo>` remove the parent as well.
    expect(worktreeAvailability(path.join(root, "a1b2", "repo"))).toBe("missing");
    // Only a filesystem or mount root survives: the volume itself is gone.
    expect(worktreeAvailability(path.join(path.sep, `${unique}-gone`, "repo"))).toBe(
      "unavailable",
    );
    expect(worktreeAvailability(`/Volumes/${unique}-unmounted/repo`)).toBe(
      "unavailable",
    );
  });

  it("rebuilds the identity that derived the worktree's resources", () => {
    const rebuilt = identityFromRecord(record({ slug: "feature-deadbeef" }));
    const adapter = postgresDatabase({
      endpoint: { stack: "infrastructure", port: "database" },
      isolation: "database",
      user: "postgres",
      password: "secret",
    });
    const resolved = adapter.resolve({
      workspace: rebuilt,
      compose: { host: "127.0.0.1", stacks: {}, url: () => "" },
      endpoint: {
        stack: "infrastructure",
        port: "database",
        host: "127.0.0.1",
        hostPort: 5432,
        url: () => "",
      },
      baseEnv: {},
    });

    expect(rebuilt.fingerprint).toBe("deadbeef");
    expect(resolved.database).toBe(buildDatabaseName("shop", "feature-deadbeef"));
  });

  it("prefers --max-idle-days over configuration and rejects bad values", () => {
    expect(resolveMaxIdleDays(undefined, {})).toBeUndefined();
    expect(resolveMaxIdleDays(undefined, { gc: { maxIdleDays: 14 } })).toBe(14);
    expect(resolveMaxIdleDays("7", { gc: { maxIdleDays: 14 } })).toBe(7);
    for (const value of ["0", "-3", "1.5", "abc", "true"]) {
      expect(() => resolveMaxIdleDays(value, {})).toThrow(/positive whole number/);
    }
  });

  it("validates gc.maxIdleDays when loading configuration", async () => {
    const directory = temporaryDirectory("worktrellis-gc-config");
    fs.writeFileSync(
      path.join(directory, "worktrellis.config.mjs"),
      `export default {
        configVersion: 3,
        project: "test",
        compose: [],
        env: () => ({}),
        processes: [],
        gc: { maxIdleDays: 0 }
      };`,
    );

    await expect(loadConfig({ cwd: directory })).rejects.toThrow(
      /`gc.maxIdleDays` must be a positive whole number/,
    );
  });

  it("warns from doctor when workspaces can be pruned", () => {
    const options = {
      records: [record(), record({ slug: "idle-66666666", worktreeRoot: "/idle", lastSeenAt: "2026-01-01T00:00:00.000Z" })],
      project: "shop",
      current: { repoKey: "repo-one", slug: "main-0000beef" },
      maxIdleDays: 30,
      now: NOW,
      leaseState: () => "none" as const,
      availability: (root: string) =>
        root === "/worktrees/feature" ? ("missing" as const) : ("present" as const),
    };

    const check = pruneDoctorCheck(options);
    expect(check).toEqual(
      expect.objectContaining({ severity: "warn", label: "2 workspace(s) can be pruned" }),
    );
    expect(check?.detail).toContain("1 deleted worktree(s), 1 idle for 30+ days");
    expect(check?.fix).toContain("worktrellis prune --yes");
    expect(pruneDoctorCheck({ ...options, records: [] })).toBeNull();
  });
});

describe("WorkTrellis prune leases", () => {
  it("reports absent and exited supervisors as prunable lease states", () => {
    vi.stubEnv("WORKTRELLIS_HOME", temporaryDirectory("worktrellis-prune-home"));

    expect(workspaceLeaseState("repo-one", "feature-deadbeef")).toBe("none");

    writeMachineRunLease({
      version: 1,
      // Far above any real pid ceiling, so the process cannot be alive.
      pid: 2_147_483_000,
      startedAtMs: NOW,
      project: "shop",
      repoKey: "repo-one",
      slug: "feature-deadbeef",
      branch: "feature",
      worktreeRoot: "/gone/feature",
      stacks: [],
    });
    expect(workspaceLeaseState("repo-one", "feature-deadbeef")).toBe("stale");
  });
});

describe("WorkTrellis machine-variant names", () => {
  it("matches only the variants of the exact stack name", () => {
    expect(isMachineVariantName("data", "worktrellis-machine-data-1a2b3c4d")).toBe(true);
    expect(
      isMachineVariantName("data", "worktrellis-machine-data-test-1a2b3c4d"),
    ).toBe(false);
    expect(isMachineVariantName("data", "worktrellis-machine-data-NOTHEX12")).toBe(false);
    expect(isMachineVariantName("data", "worktrellis-machine-data-1a2b3c4d5")).toBe(false);
    expect(isMachineVariantName("x".repeat(40), `worktrellis-machine-${"x".repeat(40)}-1a2b3c4d`)).toBe(false);
  });
});

describe("WorkTrellis machine definition cleanup", () => {
  const variant = (hash: string) => `worktrellis-machine-infrastructure-${hash}`;

  function inventory(
    containers: Record<string, number> = {},
    volumes: Record<string, string[]> = {},
  ): ComposeInventory {
    return {
      containers: new Map(
        Object.entries(containers).map(([project, total]) => [
          project,
          { total, running: total },
        ]),
      ),
      volumes: new Map(
        Object.entries(volumes).map(([project, names]) => [project, new Set(names)]),
      ),
    };
  }

  function registry(selections: Record<string, string>): LineageRegistry {
    return {
      version: 1,
      selections: Object.fromEntries(
        Object.entries(selections).map(([compatibilityId, projectName]) => [
          compatibilityId,
          { compatibilityId, projectName, ports: {}, selectedAt: "2026-10-01T00:00:00.000Z" },
        ]),
      ),
    };
  }

  function plan(options: {
    inventory?: ComposeInventory;
    registry?: LineageRegistry;
    directories: string[];
    consumers?: Record<string, LeaseConsumer["state"][]>;
  }) {
    return planMachineDefinitionCleanup({
      stackNames: ["infrastructure"],
      current: {
        compatibilityIds: new Set([variant("cccccccc")]),
        projects: new Set([variant("cccccccc")]),
      },
      inventory: options.inventory ?? inventory(),
      registry: options.registry ?? registry({}),
      stackDirectories: options.directories,
      consumers: (projectName) =>
        (options.consumers?.[projectName] ?? []).map((state) => ({
          project: "shop",
          repoKey: "repo-one",
          slug: "feature-deadbeef",
          branch: null,
          pid: 1,
          worktreeExists: true,
          state,
        })),
    });
  }

  it("removes only unreferenced definitions with nothing left", () => {
    const result = plan({
      directories: [
        variant("cccccccc"),
        variant("aaaaaaaa"),
        variant("bbbbbbbb"),
        variant("dddddddd"),
        "worktrellis-machine-test-infrastructure-eeeeeeee",
        "worktrellis-shop-feature-deadbeef-scratch",
      ],
      inventory: inventory({ [variant("bbbbbbbb")]: 1 }, { [variant("dddddddd")]: ["data"] }),
    });

    expect(result).toEqual([
      { projectName: variant("aaaaaaaa"), action: "remove-definition" },
    ]);
  });

  it("forgets selections of empty variants, then their definitions", () => {
    const result = plan({
      registry: registry({
        [variant("11111111")]: variant("aaaaaaaa"),
        [variant("22222222")]: variant("bbbbbbbb"),
        [variant("cccccccc")]: variant("cccccccc"),
      }),
      inventory: inventory({}, { [variant("bbbbbbbb")]: ["data"] }),
      directories: [variant("aaaaaaaa"), variant("bbbbbbbb"), variant("cccccccc")],
    });

    expect(result).toEqual([
      {
        projectName: variant("aaaaaaaa"),
        action: "remove-selection",
        compatibilityId: variant("11111111"),
      },
      { projectName: variant("aaaaaaaa"), action: "remove-definition" },
    ]);
  });

  it("keeps anything a live or unverified supervisor still uses", () => {
    const result = plan({
      registry: registry({ [variant("11111111")]: variant("aaaaaaaa") }),
      directories: [variant("aaaaaaaa"), variant("bbbbbbbb"), variant("dddddddd")],
      consumers: {
        [variant("aaaaaaaa")]: ["live"],
        [variant("bbbbbbbb")]: ["unverified"],
        [variant("dddddddd")]: ["stale"],
      },
    });

    expect(result).toEqual([
      { projectName: variant("dddddddd"), action: "remove-definition" },
    ]);
  });
});

describe("WorkTrellis prune resource location", () => {
  const adapter = postgresDatabase({
    endpoint: { stack: "infrastructure", port: "database" },
    isolation: "database",
    user: "postgres",
    password: "secret",
  });
  const current = {
    name: "infrastructure",
    scope: "machine" as const,
    compatibilityId: "worktrellis-machine-infrastructure-cccccccc",
    projectName: "worktrellis-machine-infrastructure-cccccccc",
    ports: { database: 5432 },
  };
  const located = (projectName: string | null, volumes: Record<string, string[]> = {}) =>
    resourceLocation({
      record: record(
        projectName
          ? {
              composeProjects: [
                { name: "infrastructure", compatibilityId: projectName, projectName },
              ],
            }
          : {},
      ),
      adapter,
      current,
      inventory: {
        containers: new Map(),
        volumes: new Map(
          Object.entries(volumes).map(([project, names]) => [project, new Set(names)]),
        ),
      },
    });

  it("checks the current stack unless the record names another one", () => {
    expect(located(null)).toEqual({ status: "here" });
    expect(located(current.projectName)).toEqual({ status: "here" });
    expect(located("worktrellis-machine-infrastructure-aaaaaaaa")).toEqual({
      status: "gone",
      projectName: "worktrellis-machine-infrastructure-aaaaaaaa",
    });
    expect(
      located("worktrellis-machine-infrastructure-aaaaaaaa", {
        "worktrellis-machine-infrastructure-aaaaaaaa": ["data"],
      }),
    ).toEqual({
      status: "elsewhere",
      projectName: "worktrellis-machine-infrastructure-aaaaaaaa",
    });
  });

  it("formats reclaimed sizes compactly", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(5_242_000_000)).toBe("5.2 GB");
    expect(formatBytes(93_010_000_000)).toBe("93.0 GB");
    expect(formatBytes(650_000_000_000)).toBe("650 GB");
  });
});
