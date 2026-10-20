import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, describe, expect, it, vi } from "vitest";

import { runPrune, type PruneReport } from "../src/commands/prune";
import { buildContext } from "../src/core/context";
import { prepareWorkspace } from "../src/core/prepare";
import { readWorkspaceRecords } from "../src/core/state";
import type { ComposeStack } from "../src/platform/compose";
import { removeWorkspaceComposeProject } from "../src/platform/cleanup";
import { detectEngine } from "../src/platform/engine";
import { stackFor } from "../src/platform/stack";
import { provisionResources } from "../src/resources";
import { databaseExists } from "../src/resources/postgres";
import type { PostgresDatabase } from "../src/types";
import { realDockerReadiness } from "./real-environment";

const readiness = realDockerReadiness({ requireGit: true });
if (process.env.WORKTRELLIS_COMPOSE_TEST === "1" && !readiness.ready) {
  process.stderr.write(`[worktrellis prune smoke] skipped: ${readiness.reason}\n`);
}

let temporaryRoot: string | undefined;
const cleanupStacks = new Map<string, ComposeStack>();

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function prune(cwd: string, yes: boolean): Promise<PruneReport> {
  const output: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((value: unknown) => {
    output.push(String(value));
  });
  try {
    await runPrune({ cwd, json: true, yes });
  } finally {
    log.mockRestore();
  }
  return JSON.parse(output.join("\n")) as PruneReport;
}

function composeResources(engine: string, kind: "ps" | "volume", project: string): string[] {
  const args =
    kind === "ps"
      ? ["ps", "-a", "--filter", `label=com.docker.compose.project=${project}`, "-q"]
      : ["volume", "ls", "--filter", `label=com.docker.compose.project=${project}`, "-q"];
  return execFileSync(engine, args, { encoding: "utf8" })
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
}

describe.skipIf(!readiness.ready)(
  `real worktree prune smoke${readiness.reason ? ` (skipped: ${readiness.reason})` : ""}`,
  () => {
    it("drops only the resources of a removed linked worktree", async () => {
      temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "worktrellis-prune-smoke-"));
      const repositoryRoot = path.join(temporaryRoot, "repository");
      const linkedRoot = path.join(temporaryRoot, "linked-worktree");
      fs.mkdirSync(repositoryRoot);
      vi.stubEnv("WORKTRELLIS_HOME", path.join(temporaryRoot, "worktrellis-home"));

      git(repositoryRoot, ["init", "--quiet"]);
      git(repositoryRoot, ["symbolic-ref", "HEAD", "refs/heads/main"]);
      fs.writeFileSync(path.join(repositoryRoot, ".gitignore"), ".worktrellis/\n");
      fs.writeFileSync(
        path.join(repositoryRoot, "compose.database.yml"),
        [
          "services:",
          "  postgres:",
          "    image: postgres:16-alpine",
          "    environment:",
          "      POSTGRES_PASSWORD: ${PRUNE_SMOKE_PASSWORD:?required}",
          "    healthcheck:",
          '      test: ["CMD-SHELL", "pg_isready -U postgres"]',
          "      interval: 1s",
          "      timeout: 3s",
          "      retries: 30",
          "    volumes:",
          "      - data:/var/lib/postgresql/data",
          "volumes:",
          "  data: {}",
          "",
        ].join("\n"),
      );
      fs.writeFileSync(
        path.join(repositoryRoot, "compose.scratch.yml"),
        [
          "services:",
          "  scratch:",
          "    image: nginx:alpine",
          "    volumes:",
          "      - scratch:/usr/share/nginx/html",
          "volumes:",
          "  scratch: {}",
          "",
        ].join("\n"),
      );
      const resources = pathToFileURL(
        path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/resources/index.ts"),
      ).href;
      fs.writeFileSync(
        path.join(repositoryRoot, "worktrellis.config.mjs"),
        `import { postgresDatabase } from ${JSON.stringify(resources)};

export default {
  configVersion: 3,
  project: "prune-smoke",
  compose: [
    {
      name: "prune-smoke-database",
      scope: "machine",
      files: ["compose.database.yml"],
      env: { PRUNE_SMOKE_PASSWORD: "prune-smoke" },
      ports: {
        database: { service: "postgres", containerPort: 5432, probe: { kind: "postgres" } }
      }
    },
    {
      name: "scratch",
      scope: "workspace",
      files: ["compose.scratch.yml"],
      ports: {
        http: { service: "scratch", containerPort: 80, probe: { kind: "http", path: "/" } }
      }
    }
  ],
  resources: {
    database: postgresDatabase({
      endpoint: { stack: "prune-smoke-database", port: "database" },
      isolation: "database",
      user: "postgres",
      password: "prune-smoke"
    })
  },
  env: () => ({}),
  processes: [],
  url: { provider: "direct" }
};
`,
      );
      git(repositoryRoot, ["add", "."]);
      git(repositoryRoot, [
        "-c",
        "user.name=WorkTrellis Smoke",
        "-c",
        "user.email=smoke@worktrellis.invalid",
        "commit",
        "--quiet",
        "-m",
        "prune smoke fixture",
      ]);
      git(repositoryRoot, [
        "worktree",
        "add",
        "--quiet",
        "-b",
        "prune-smoke-linked",
        linkedRoot,
        "main",
      ]);

      const engine = await detectEngine();
      for (const cwd of [repositoryRoot, linkedRoot]) {
        const context = await buildContext({ cwd });
        for (const spec of context.config.compose) {
          const candidate = stackFor(
            engine,
            spec,
            context.projectRoot,
            context.identity,
            Object.fromEntries(context.baseEnv),
          );
          cleanupStacks.set(candidate.rendered.stackId, candidate);
        }
      }

      const prepared = [];
      for (const cwd of [repositoryRoot, linkedRoot]) {
        const workspace = await prepareWorkspace({
          cwd,
          startServices: true,
          urlPreference: "direct",
          peekUrl: true,
        });
        await provisionResources({
          adapters: workspace.context.config.resources,
          resources: workspace.envContext.resources,
          compose: workspace.envContext.compose,
          identity: workspace.context.identity,
          projectRoot: workspace.context.projectRoot,
          baseEnv: workspace.envContext.baseEnv,
        });
        prepared.push(workspace);
      }
      const [main, linked] = prepared as [
        (typeof prepared)[number],
        (typeof prepared)[number],
      ];
      const mainDatabase = main.envContext.resources.database as PostgresDatabase;
      const linkedDatabase = linked.envContext.resources.database as PostgresDatabase;
      const linkedScratch = linked.infrastructure.stacks.find(
        ({ spec }) => spec.name === "scratch",
      )!.stack.rendered.stackId;
      expect(mainDatabase.database).not.toBe(linkedDatabase.database);
      expect(await databaseExists(linkedDatabase.url, linkedDatabase.database)).toBe(true);
      expect(composeResources(engine.cli, "volume", linkedScratch)).toHaveLength(1);

      git(repositoryRoot, ["worktree", "remove", "--force", linkedRoot]);

      const preview = await prune(repositoryRoot, false);
      expect(preview.dryRun).toBe(true);
      expect(preview.workspaces).toHaveLength(1);
      expect(preview.workspaces[0]).toEqual(
        expect.objectContaining({
          slug: linked.context.identity.slug,
          reason: "missing",
          record: "would-remove",
        }),
      );
      expect(preview.workspaces[0]!.resources).toEqual([
        expect.objectContaining({ name: "database", status: "would-remove" }),
      ]);
      expect(preview.workspaces[0]!.stacks).toEqual([
        expect.objectContaining({
          projectName: linkedScratch,
          status: "would-remove",
          volumes: 1,
        }),
      ]);
      expect(await databaseExists(linkedDatabase.url, linkedDatabase.database)).toBe(true);
      expect(composeResources(engine.cli, "volume", linkedScratch)).toHaveLength(1);

      const applied = await prune(repositoryRoot, true);
      expect(applied.workspaces[0]).toEqual(
        expect.objectContaining({ record: "removed" }),
      );
      expect(applied.workspaces[0]!.resources[0]).toEqual(
        expect.objectContaining({ status: "removed" }),
      );
      expect(await databaseExists(linkedDatabase.url, linkedDatabase.database)).toBe(false);
      expect(await databaseExists(mainDatabase.url, mainDatabase.database)).toBe(true);
      expect(composeResources(engine.cli, "ps", linkedScratch)).toHaveLength(0);
      expect(composeResources(engine.cli, "volume", linkedScratch)).toHaveLength(0);
      expect(
        readWorkspaceRecords({ project: "prune-smoke" }).map((record) => record.slug),
      ).toEqual([main.context.identity.slug]);

      const again = await prune(repositoryRoot, false);
      expect(again.workspaces).toHaveLength(0);
    }, 300_000);
  },
);

afterAll(async () => {
  const failures: unknown[] = [];
  for (const candidate of [...cleanupStacks.values()].reverse()) {
    try {
      // Prune may already have removed a stack and its generated definition;
      // label-based removal needs no Compose file.
      await removeWorkspaceComposeProject(candidate.engine, candidate.rendered.stackId);
    } catch (error) {
      failures.push(error);
    }
  }

  vi.unstubAllEnvs();
  if (temporaryRoot) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, "failed to clean up prune smoke stacks");
  }
});
