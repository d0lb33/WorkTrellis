import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveInfoComposeProjects } from "../src/commands/info";
import { resolvePackageManager } from "../src/commands/misc";
import { runSelfCheck } from "../src/commands/self-check";
import { parseArgs } from "../src/core/args";
import { loadConfig } from "../src/core/config";
import { buildContext } from "../src/core/context";
import { resolveEnv } from "../src/core/env-resolve";
import { loadWorkspaceLocalConfig } from "../src/core/local-config";
import { renderStack } from "../src/platform/compose-render";
import {
  describeMachineStackVariants,
  findRunningMachineStackVariants,
} from "../src/platform/stack";
import { resolveResources } from "../src/resources";
import {
  defineResourceAdapter,
  postgresDatabase,
  redisNamespace,
  s3Bucket,
} from "../src/resources";
import {
  sanitizeMultiplexedOutput,
  Supervisor,
} from "../src/supervise/supervisor";
import { resolveUrl } from "../src/url/provider";
import { claimPortlessAlias } from "../src/url/portless";
import type {
  ComposeContext,
  EnvContext,
  WorkspaceIdentity,
  WorkTrellisConfig,
} from "../src/types";

const temporaryDirectories: string[] = [];

function temporaryDirectory(label: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

function identity(overrides: Partial<WorkspaceIdentity> = {}): WorkspaceIdentity {
  return {
    root: "/worktrees/example",
    repoKey: "repo-key",
    isLinkedWorktree: true,
    branch: "feature/test",
    head: "abc123",
    project: "test",
    slug: "feature-test-deadbeef",
    fingerprint: "deadbeef",
    ports: { app: 3210 },
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("WorkTrellis environment precedence", () => {
  it("lets exported values override generated keys and base-env secrets", () => {
    vi.stubEnv("WORKTRELLIS_TEST_SECRET", "from-process");
    vi.stubEnv("WORKTRELLIS_TEST_OWNED", "owned-from-process");

    const config: WorkTrellisConfig = {
      configVersion: 2,
      project: "test",
      compose: [],
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

describe("WorkTrellis package boundary", () => {
  it("keeps host-project vocabulary out of package source", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(runSelfCheck()).toBe(0);
  });
});

describe("WorkTrellis process supervision", () => {
  it("prevents one multiplexed child from clearing sibling output", () => {
    expect(
      sanitizeMultiplexedOutput(
        "\u001bc\u001b[2J\u001b[H\u001b[35mworker restarted\u001b[39m",
      ),
    ).toBe("\u001b[35mworker restarted\u001b[39m");
  });

  it("does not start a dependent when its dependency fails readiness", async () => {
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
        command: { bin: process.execPath, args: ["-e", "process.exit(1)"] },
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
        configVersion: 2,
        project: "test",
        compose: [],
        env: () => ({}),
        processes: [
          { name: "app", command: { bin: process.execPath, args: [] }, dependsOn: ["worker"] },
          { name: "worker", command: { bin: process.execPath, args: [] }, dependsOn: ["app"] }
        ]
      };`,
    );

    await expect(loadConfig({ cwd: directory, configPath })).rejects.toThrow(
      /dependency cycle: app -> worker -> app/,
    );
  });

  it("rejects configuration version 1", async () => {
    const directory = temporaryDirectory("worktrellis-config-version");
    fs.writeFileSync(
      path.join(directory, "worktrellis.config.mjs"),
      `export default {
        configVersion: 1,
        project: "test",
        compose: [],
        env: () => ({}),
        processes: []
      };`,
    );

    await expect(loadConfig({ cwd: directory })).rejects.toThrow(
      /requires `configVersion: 2`/,
    );
  });
});

describe("WorkTrellis scoped Compose plans", () => {
  it("reports the exact Docker Compose project names expected for this workspace", () => {
    const projectRoot = temporaryDirectory("worktrellis-info-compose");
    fs.writeFileSync(
      path.join(projectRoot, "compose.machine.yml"),
      "services:\n  database:\n    image: postgres:16-alpine\n",
    );
    fs.writeFileSync(
      path.join(projectRoot, "compose.workspace.yml"),
      "services:\n  search:\n    image: opensearchproject/opensearch:latest\n",
    );

    const workspace = identity();
    const compose = [
      {
        name: "infrastructure",
        scope: "machine" as const,
        files: ["compose.machine.yml"],
      },
      {
        name: "search",
        scope: "workspace" as const,
        files: ["compose.workspace.yml"],
      },
    ];
    const projects = resolveInfoComposeProjects({
      config: { compose } as WorkTrellisConfig,
      projectRoot,
      identity: workspace,
      baseEnv: new Map(),
    });

    expect(projects).toEqual([
      expect.objectContaining({
        name: "infrastructure",
        scope: "machine",
        projectName: expect.stringMatching(
          /^worktrellis-machine-infrastructure-[a-f0-9]{8}$/,
        ),
      }),
      expect.objectContaining({
        name: "search",
        scope: "workspace",
        projectName: `worktrellis-${workspace.project}-${workspace.slug}-search`,
      }),
    ]);
  });

  it("shares machine stacks but separates workspace stacks", () => {
    const projectRoot = temporaryDirectory("worktrellis-compose");
    const machineFile = path.join(projectRoot, "compose.machine.yml");
    fs.writeFileSync(
      machineFile,
      "services:\n  database:\n    image: postgres:16-alpine\n",
    );
    const first = identity();
    const second = identity({
      root: "/worktrees/second",
      slug: "second-cafebabe",
      fingerprint: "cafebabe",
    });

    const machineFirst = renderStack({
      spec: {
        name: "infrastructure",
        scope: "machine",
        files: ["compose.machine.yml"],
        ports: {
          database: { service: "database", containerPort: 5432 },
        },
      },
      projectRoot,
      identity: first,
    });
    const machineSecond = renderStack({
      spec: {
        name: "infrastructure",
        scope: "machine",
        files: ["compose.machine.yml"],
        ports: {
          database: { service: "database", containerPort: 5432 },
        },
      },
      projectRoot,
      identity: second,
    });
    expect(machineFirst.stackId).toBe(machineSecond.stackId);

    const composeFile = path.join(projectRoot, "compose.dev.yml");
    fs.writeFileSync(
      composeFile,
      "services:\n  gotenberg:\n    image: gotenberg/gotenberg:8\n",
    );
    const workspaceSpec = {
      name: "documents",
      scope: "workspace" as const,
      files: ["compose.dev.yml"],
      ports: {
        gotenberg: {
          service: "gotenberg",
          containerPort: 3000,
        },
      },
    };
    const workspaceFirst = renderStack({
      spec: workspaceSpec,
      projectRoot,
      identity: first,
    });
    const workspaceSecond = renderStack({
      spec: workspaceSpec,
      projectRoot,
      identity: second,
    });
    expect(workspaceFirst.stackId).not.toBe(workspaceSecond.stackId);
    expect(
      workspaceFirst.files.at(-1)?.contents,
    ).toContain('"gotenberg"');
    expect(workspaceFirst.environment.WORKTRELLIS_PORT_GOTENBERG).toBe(
      String(workspaceFirst.ports.gotenberg),
    );
  });

  it("explains when resolved Compose inputs would start another machine variant", () => {
    const projectRoot = temporaryDirectory("worktrellis-machine-variant");
    const home = temporaryDirectory("worktrellis-machine-variant-home");
    vi.stubEnv("WORKTRELLIS_HOME", home);
    fs.writeFileSync(
      path.join(projectRoot, "compose.machine.yml"),
      "services:\n  database:\n    image: postgres:16-alpine\n",
    );
    const spec = {
      name: "infrastructure",
      scope: "machine" as const,
      files: ["compose.machine.yml"],
      env: {
        DB_PASSWORD: ({
          baseEnv,
        }: {
          baseEnv: Readonly<Record<string, string>>;
        }) => baseEnv.DB_PASSWORD,
      },
      ports: {
        database: { service: "database", containerPort: 5432 },
      },
    };
    const existing = renderStack({
      spec,
      projectRoot,
      identity: identity(),
      baseEnv: { DB_PASSWORD: "first" },
    });
    const current = renderStack({
      spec,
      projectRoot,
      identity: identity({ slug: "second-cafebabe" }),
      baseEnv: { DB_PASSWORD: "second" },
    });
    const existingDirectory = path.join(home, "stacks", existing.stackId);
    fs.mkdirSync(existingDirectory, { recursive: true });
    for (const file of existing.files) {
      fs.writeFileSync(path.join(existingDirectory, file.name), file.contents);
    }
    fs.writeFileSync(
      path.join(existingDirectory, "files.json"),
      JSON.stringify(existing.files.map((file) => file.name)),
    );

    const variants = findRunningMachineStackVariants(
      current,
      new Set([existing.stackId]),
    );
    const explanation = describeMachineStackVariants(current, variants);

    expect(current.stackId).not.toBe(existing.stackId);
    expect(variants).toEqual([
      { stackId: existing.stackId, projectFilesMatch: true },
    ]);
    expect(explanation).toContain("another set of containers and volumes");
    expect(explanation).toContain("DB_PASSWORD");
    expect(explanation).toContain("compare the worktrees' .env files");
    expect(explanation).not.toContain("first");
    expect(explanation).not.toContain("second");
  });

  it("requires project-owned Compose files instead of a runtime preset", async () => {
    const directory = temporaryDirectory("worktrellis-project-compose");
    fs.writeFileSync(
      path.join(directory, "worktrellis.config.mjs"),
      `export default {
        configVersion: 2,
        project: "test",
        compose: [{ name: "infrastructure", scope: "machine", files: [] }],
        env: () => ({}),
        processes: []
      };`,
    );

    await expect(loadConfig({ cwd: directory })).rejects.toThrow(
      /needs at least one project-owned file/,
    );
  });

  it("resolves explicit Compose inputs from base env into compatibility identity", () => {
    const projectRoot = temporaryDirectory("worktrellis-compose-env");
    fs.writeFileSync(
      path.join(projectRoot, "compose.yml"),
      "services:\n  database:\n    image: postgres:16-alpine\n",
    );
    const spec = {
      name: "infrastructure",
      scope: "machine" as const,
      files: ["compose.yml"],
      env: {
        POSTGRES_PASSWORD: ({
          baseEnv,
        }: {
          baseEnv: Readonly<Record<string, string>>;
        }) => baseEnv.POSTGRES_PASSWORD,
      },
    };

    const first = renderStack({
      spec,
      projectRoot,
      identity: identity(),
      baseEnv: { POSTGRES_PASSWORD: "first" },
    });
    const second = renderStack({
      spec,
      projectRoot,
      identity: identity(),
      baseEnv: { POSTGRES_PASSWORD: "second" },
    });

    expect(first.environment.POSTGRES_PASSWORD).toBe("first");
    expect(first.stackId).not.toBe(second.stackId);
  });
});

describe("WorkTrellis resource isolation", () => {
  it("resolves database, Redis namespace, and bucket from one workspace", () => {
    const compose: ComposeContext = {
      stacks: {
        standard: {
          name: "standard",
          scope: "machine",
          projectName: "worktrellis-machine-standard",
          ports: { postgres: 5432, redis: 6379, minio: 9000 },
        },
      },
      url: () => "",
    };
    const resources = resolveResources({
      identity: identity(),
      compose,
      adapters: {
        database: postgresDatabase({
          endpoint: { stack: "standard", port: "postgres" },
          isolation: "database",
        }),
        cache: redisNamespace({
          endpoint: { stack: "standard", port: "redis" },
          isolation: "namespace",
        }),
        storage: s3Bucket({
          endpoint: { stack: "standard", port: "minio" },
          isolation: "bucket",
        }),
      },
    });

    expect(resources.database.database).toBe(
      "test_feature_test_deadbeef",
    );
    expect(resources.cache.prefix).toBe(
      "{test:feature-test-deadbeef}",
    );
    expect(resources.storage.bucket).toBe(
      "test-feature-test-deadbeef",
    );
  });

  it("keeps custom adapter names and resolved values intact", () => {
    const compose: ComposeContext = {
      stacks: {
        search: {
          name: "search",
          scope: "workspace",
          projectName: "worktrellis-test-search",
          ports: { api: 9200 },
        },
      },
      url: () => "",
    };
    const adapter = defineResourceAdapter({
      kind: "search-index",
      isolation: "index",
      endpoint: { stack: "search", port: "api" },
      resolve: ({ workspace, endpoint, baseEnv }) => ({
        url: endpoint.url(),
        index: `${workspace.project}-${workspace.slug}`,
        token: baseEnv.SEARCH_TOKEN,
      }),
    });

    const resources = resolveResources({
      identity: identity(),
      compose,
      adapters: { documents: adapter },
      baseEnv: { SEARCH_TOKEN: "local-secret" },
    });

    expect(resources.documents).toEqual({
      url: "http://127.0.0.1:9200",
      index: "test-feature-test-deadbeef",
      token: "local-secret",
    });
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

  it("parses stack-qualified machine port overrides", () => {
    const parsed = parseArgs([
      "services",
      "adopt",
      "--infrastructure.database-port",
      "55432",
    ]);
    expect(parsed.flags.get("infrastructure.database-port")).toBe("55432");
  });

  it("uses the inherited package-manager JavaScript entry", () => {
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

describe("WorkTrellis URL inspection", () => {
  it("previews a worktree URL without registering a route", async () => {
    const config: WorkTrellisConfig = {
      configVersion: 2,
      project: "test",
      compose: [],
      processes: [],
      env: () => ({}),
      url: { provider: "portless" },
    };
    const resolved = await resolveUrl({
      identity: identity(),
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

  it("uses a workspace-local hostname override without changing identity", async () => {
    const config: WorkTrellisConfig = {
      configVersion: 2,
      project: "test",
      compose: [],
      processes: [],
      env: () => ({}),
      url: { provider: "portless" },
    };
    const resolved = await resolveUrl({
      identity: identity(),
      projectRoot: temporaryDirectory("worktrellis-url-override"),
      config,
      hostname: "stars-local",
      peek: true,
    });

    expect(resolved.url).toMatchObject({
      mode: "portless",
      appUrl: "https://stars-local.localhost",
      rootDomain: "stars-local.localhost",
      tenantUrlTemplate: "https://<subdomain>.stars-local.localhost",
    });
    expect(identity().slug).toBe("feature-test-deadbeef");
  });

  it("leases hostname overrides so two running worktrees cannot share one", async () => {
    const home = temporaryDirectory("worktrellis-hostname-lease");
    vi.stubEnv("WORKTRELLIS_HOME", home);

    const first = await claimPortlessAlias("stars-local", 10);
    await expect(claimPortlessAlias("stars-local", 10)).rejects.toThrow(
      /another WorkTrellis process is already using it/,
    );

    first.release();
    const next = await claimPortlessAlias("stars-local", 10);
    next.release();
  });
});

describe("WorkTrellis workspace-local configuration", () => {
  it("loads a valid gitignored hostname override", () => {
    const directory = temporaryDirectory("worktrellis-local-config");
    const file = path.join(directory, "local.json");
    fs.writeFileSync(
      file,
      JSON.stringify({ url: { hostname: "stars-local" } }),
    );

    expect(loadWorkspaceLocalConfig(file)).toEqual({
      url: { hostname: "stars-local" },
    });
  });

  it("wires the local override into the command context", async () => {
    const directory = temporaryDirectory("worktrellis-local-context");
    execFileSync("git", ["init", "--quiet"], { cwd: directory });
    fs.writeFileSync(
      path.join(directory, "worktrellis.config.mjs"),
      `export default {
        configVersion: 2,
        project: "test",
        compose: [],
        env: () => ({}),
        processes: []
      };`,
    );
    fs.mkdirSync(path.join(directory, ".worktrellis"));
    fs.writeFileSync(
      path.join(directory, ".worktrellis", "local.json"),
      JSON.stringify({ url: { hostname: "test-local" } }),
    );

    const context = await buildContext({ cwd: directory });

    expect(context.localConfig.url?.hostname).toBe("test-local");
    expect(context.identity.slug).not.toBe("test-local");
  });

  it("rejects URLs, localhost suffixes, and unknown keys", () => {
    const directory = temporaryDirectory("worktrellis-local-config-invalid");
    const file = path.join(directory, "local.json");

    fs.writeFileSync(
      file,
      JSON.stringify({ url: { hostname: "https://stars-local.localhost/" } }),
    );
    expect(() => loadWorkspaceLocalConfig(file)).toThrow(
      /hostname below \.localhost, not a URL/,
    );

    fs.writeFileSync(
      file,
      JSON.stringify({ url: { hostName: "stars-local" } }),
    );
    expect(() => loadWorkspaceLocalConfig(file)).toThrow(/unknown key/i);
  });
});
