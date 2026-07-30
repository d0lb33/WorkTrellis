import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolvePackageManager } from "../src/commands/misc";
import { parseArgs } from "../src/core/args";
import { loadConfig } from "../src/core/config";
import { resolveEnv } from "../src/core/env-resolve";
import {
  workspacePaths,
  worktrellisHome,
} from "../src/core/state";
import { ComposeStack } from "../src/platform/compose";
import {
  renderLegacyStack,
  stackIdFor,
} from "../src/platform/compose-render";
import { stackFor } from "../src/platform/stack";
import { Supervisor } from "../src/supervise/supervisor";
import { resolveUrl } from "../src/url/provider";
import type {
  EnvContext,
  ServiceSpec,
  WorkTrellisConfig,
} from "../src/types";
import type { ContainerEngine } from "../src/platform/engine";

const temporaryDirectories: string[] = [];

function temporaryDirectory(label: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("WorkTrellis environment precedence", () => {
  it("lets exported values override both generated keys and base-env secrets", () => {
    vi.stubEnv("WORKTRELLIS_TEST_SECRET", "from-process");
    vi.stubEnv("WORKTRELLIS_TEST_OWNED", "owned-from-process");

    const config: WorkTrellisConfig = {
      configVersion: 1,
      project: "test",
      services: [],
      processes: [],
      env: () => ({ WORKTRELLIS_TEST_OWNED: "owned-from-config" }),
    };
    const baseEnv = new Map([["WORKTRELLIS_TEST_SECRET", "from-file"]]);

    const result = resolveEnv(
      config,
      { url: { providerEnv: {} } } as unknown as EnvContext,
      baseEnv,
    );

    expect(result.combined.WORKTRELLIS_TEST_SECRET).toBe("from-process");
    expect(result.combined.WORKTRELLIS_TEST_OWNED).toBe("owned-from-process");
    expect(result.owned.WORKTRELLIS_TEST_OWNED).toBe("owned-from-config");
    expect(result.overriddenByProcess).toEqual(["WORKTRELLIS_TEST_OWNED"]);
  });
});

describe("WorkTrellis process supervision", () => {
  it("resolves when a dependency fails before becoming ready", async () => {
    const directory = temporaryDirectory("worktrellis-supervisor");
    const dependentMarker = path.join(directory, "dependent-started");
    const supervisor = new Supervisor({
      projectRoot: process.cwd(),
      env: {},
      envContext: {} as EnvContext,
      runFile: path.join(directory, "run.json"),
      logDirectory: path.join(directory, "logs"),
      identity: { project: "test", slug: "test", root: process.cwd() },
      aliases: [],
    });

    supervisor.add(
      {
        name: "dependency",
        command: {
          bin: process.execPath,
          args: ["-e", "process.exit(1)"],
        },
        readyWhen: { logMatch: /never/, timeoutMs: 500 },
      },
      0,
    );
    supervisor.add(
      {
        name: "dependent",
        command: {
          bin: process.execPath,
          args: [
            "-e",
            "require('node:fs').writeFileSync(process.argv[1], 'started')",
            dependentMarker,
          ],
        },
        dependsOn: ["dependency"],
      },
      1,
    );

    await expect(supervisor.run()).resolves.toBe(1);
    expect(fs.existsSync(dependentMarker)).toBe(false);
  });

  it("rejects dependency cycles while loading configuration", async () => {
    const directory = temporaryDirectory("worktrellis-config");
    const configPath = path.join(directory, "worktrellis.config.mjs");
    fs.writeFileSync(
      configPath,
      `export default {
        configVersion: 1,
        project: "test",
        services: [],
        env: () => ({}),
        processes: [
          { name: "app", command: { bin: process.execPath, args: [] }, dependsOn: ["worker"] },
          { name: "worker", command: { bin: process.execPath, args: [] }, dependsOn: ["app"] }
        ]
      };`,
    );

    await expect(
      loadConfig({ cwd: directory, configPath }),
    ).rejects.toThrow(/dependency cycle: app -> worker -> app/);
  });

  it("rejects missing and unknown configuration versions", async () => {
    const directory = temporaryDirectory("worktrellis-config-version");
    const configPath = path.join(directory, "worktrellis.config.mjs");
    const base = {
      project: "test",
      services: [],
      env: "() => ({})",
      processes: [],
    };

    fs.writeFileSync(
      configPath,
      `export default {
        project: ${JSON.stringify(base.project)},
        services: [],
        env: ${base.env},
        processes: []
      };`,
    );
    await expect(loadConfig({ cwd: directory })).rejects.toThrow(
      /unsupported `configVersion` undefined/,
    );

    const futureDirectory = temporaryDirectory(
      "worktrellis-config-version-future",
    );
    const futureConfigPath = path.join(
      futureDirectory,
      "worktrellis.config.mjs",
    );
    fs.writeFileSync(
      futureConfigPath,
      `export default {
        configVersion: 2,
        project: ${JSON.stringify(base.project)},
        services: [],
        env: ${base.env},
        processes: []
      };`,
    );
    await expect(loadConfig({ cwd: futureDirectory })).rejects.toThrow(
      /unsupported `configVersion` 2/,
    );
  });
});

describe("WorkTrellis state compatibility", () => {
  it("uses legacy machine state when no renamed home exists", () => {
    const directory = temporaryDirectory("worktrellis-state-home");
    const legacy = path.join(directory, ".devstack");
    fs.mkdirSync(legacy);
    vi.spyOn(os, "homedir").mockReturnValue(directory);
    vi.stubEnv("WORKTRELLIS_HOME", "");
    vi.stubEnv("DEVSTACK_HOME", "");

    expect(worktrellisHome()).toBe(legacy);
  });

  it("copies legacy workspace state forward without deleting the backup", () => {
    const directory = temporaryDirectory("worktrellis-state-workspace");
    const legacy = path.join(directory, ".devstack");
    fs.mkdirSync(legacy);
    fs.writeFileSync(path.join(legacy, "workspace.json"), '{"slug":"old"}');

    const paths = workspacePaths(directory);

    expect(paths.root).toBe(path.join(directory, ".worktrellis"));
    expect(fs.readFileSync(paths.workspace, "utf8")).toBe('{"slug":"old"}');
    expect(fs.existsSync(path.join(legacy, "workspace.json"))).toBe(true);
  });
});

describe("WorkTrellis package scripts", () => {
  it("preserves package-script arguments after the separator", () => {
    const parsed = parseArgs([
      "run",
      "db:restore",
      "--",
      "./backups/latest.dump",
      "--clean",
    ]);

    expect(parsed.positionals).toEqual(["db:restore"]);
    expect(parsed.passthrough).toEqual([
      "./backups/latest.dump",
      "--clean",
    ]);
  });

  it("uses the inherited package-manager JavaScript entry instead of a local dependency", () => {
    const directory = temporaryDirectory("worktrellis-package-manager");
    const runner = path.join(directory, "pnpm.cjs");
    fs.writeFileSync(runner, "");
    fs.writeFileSync(
      path.join(directory, "package.json"),
      JSON.stringify({ packageManager: "pnpm@10.12.1" }),
    );
    vi.stubEnv("npm_execpath", runner);

    expect(resolvePackageManager(directory)).toEqual({
      file: process.execPath,
      args: [fs.realpathSync.native(runner)],
      name: "pnpm",
    });
  });
});

describe("WorkTrellis shared service compatibility", () => {
  const engine: ContainerEngine = {
    name: "docker",
    cli: "docker",
    compose: ["docker", "compose"],
  };
  const postgres: ServiceSpec = { kind: "postgres", version: "16" };
  const ports = { main: 5432 };

  it("keeps the stack identity when only a machine port override changes", () => {
    expect(stackIdFor(postgres, { main: 5432 })).toBe(
      stackIdFor(postgres, { main: 5544 }),
    );
    expect(
      stackIdFor({ ...postgres, port: 5544 }, { main: 5544 }),
    ).not.toBe(stackIdFor(postgres, { main: 5544 }));
  });

  it("reuses an exactly matching legacy stack so existing volumes survive upgrades", () => {
    const home = temporaryDirectory("worktrellis-home");
    vi.stubEnv("WORKTRELLIS_HOME", home);

    const legacy = new ComposeStack(
      engine,
      renderLegacyStack(postgres, ports),
    );
    legacy.sync();

    const selected = stackFor(engine, postgres, ports);
    expect(selected.rendered.stackId).toBe(legacy.rendered.stackId);
    expect(selected.matchesDefinition()).toBe(true);
  });

  it("does not reuse a legacy stack whose service definition differs", () => {
    const home = temporaryDirectory("worktrellis-home");
    vi.stubEnv("WORKTRELLIS_HOME", home);

    const legacy = new ComposeStack(
      engine,
      renderLegacyStack(postgres, ports),
    );
    legacy.sync();

    const incompatible: ServiceSpec = {
      kind: "postgres",
      version: "16",
      password: "different",
    };
    const selected = stackFor(engine, incompatible, ports);

    expect(selected.rendered.stackId).toBe(stackIdFor(incompatible, ports));
    expect(selected.rendered.stackId).not.toBe(legacy.rendered.stackId);
  });
});

describe("WorkTrellis URL inspection", () => {
  it("previews a worktree URL without registering a route", async () => {
    const identity = {
      root: "/worktrees/example",
      repoKey: "repo-key",
      isLinkedWorktree: true,
      branch: "feature/test",
      head: "abc123",
      project: "test",
      slug: "feature-test-deadbeef",
      fingerprint: "deadbeef",
      databaseName: "test_feature_test_deadbeef",
      bucketName: "test-feature-test-deadbeef",
      redisPrefix: "test:feature-test-deadbeef",
      redisDb: 1,
      ports: { app: 3210 },
    };
    const config: WorkTrellisConfig = {
      configVersion: 1,
      project: "test",
      services: [],
      processes: [],
      env: () => ({}),
      url: { provider: "portless" },
    };

    const resolved = await resolveUrl({
      identity,
      projectRoot: temporaryDirectory("worktrellis-url"),
      config,
      peek: true,
    });

    expect(resolved.url).toMatchObject({
      mode: "portless",
      appUrl: "https://feature-test-deadbeef.test.localhost",
      listenPort: 3210,
    });
  });
});
