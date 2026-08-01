import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { buildContext } from "../src/core/context";
import { prepareWorkspace, type PreparedWorkspace } from "../src/core/prepare";
import { readEnvFile } from "../src/util/dotenv";
import { detectEngine } from "../src/platform/engine";
import { ComposeStack } from "../src/platform/compose";
import { stackFor } from "../src/platform/stack";
import { realDockerReadiness } from "./real-environment";

const readiness = realDockerReadiness({ requireGit: true });
if (
  process.env.WORKTRELLIS_COMPOSE_TEST === "1" &&
  !readiness.ready
) {
  process.stderr.write(
    `[worktrellis scope smoke] skipped: ${readiness.reason}\n`,
  );
}

let temporaryRoot: string | undefined;
const cleanupStacks = new Map<string, ComposeStack>();

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function stack(
  prepared: PreparedWorkspace,
  name: "machine" | "repository" | "workspace",
) {
  const found = prepared.infrastructure.stacks.find(
    ({ spec }) => spec.name === name,
  );
  if (!found) throw new Error(`missing ${name} stack`);
  return found.stack;
}

function envSnapshot(prepared: PreparedWorkspace): Record<string, string> {
  return Object.fromEntries(readEnvFile(prepared.context.paths.env));
}

describe.skipIf(!readiness.ready)(
  `real Git worktree and Docker scope smoke${readiness.reason ? ` (skipped: ${readiness.reason})` : ""}`,
  () => {
    it("shares machine and repository stacks while isolating workspace stacks", async () => {
      temporaryRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "worktrellis-scope-smoke-"),
      );
      const repositoryRoot = path.join(temporaryRoot, "repository");
      const linkedRoot = path.join(temporaryRoot, "linked-worktree");
      fs.mkdirSync(repositoryRoot);
      vi.stubEnv(
        "WORKTRELLIS_HOME",
        path.join(temporaryRoot, "worktrellis-home"),
      );

      git(repositoryRoot, ["init", "--quiet"]);
      git(repositoryRoot, ["symbolic-ref", "HEAD", "refs/heads/main"]);

      fs.writeFileSync(
        path.join(repositoryRoot, ".gitignore"),
        ".worktrellis/\n",
      );
      fs.writeFileSync(
        path.join(repositoryRoot, "compose.smoke.yml"),
        [
          "services:",
          "  probe:",
          "    image: nginx:alpine",
          "    restart: unless-stopped",
          "",
        ].join("\n"),
      );
      fs.writeFileSync(
        path.join(repositoryRoot, "worktrellis.config.mjs"),
        `const port = {
  http: {
    service: "probe",
    containerPort: 80,
    probe: { kind: "http", path: "/" }
  }
};

export default {
  configVersion: 3,
  project: "scope-smoke",
  compose: [
    { name: "machine", scope: "machine", files: ["compose.smoke.yml"], ports: port },
    { name: "repository", scope: "repository", files: ["compose.smoke.yml"], ports: port },
    { name: "workspace", scope: "workspace", files: ["compose.smoke.yml"], ports: port }
  ],
  env: ({ workspace, compose }) => ({
    SMOKE_REPO_KEY: workspace.repoKey,
    SMOKE_WORKSPACE_SLUG: workspace.slug,
    SMOKE_MACHINE_PROJECT: compose.stacks.machine.projectName,
    SMOKE_MACHINE_PORT: String(compose.stacks.machine.ports.http),
    SMOKE_REPOSITORY_PROJECT: compose.stacks.repository.projectName,
    SMOKE_REPOSITORY_PORT: String(compose.stacks.repository.ports.http),
    SMOKE_WORKSPACE_PROJECT: compose.stacks.workspace.projectName,
    SMOKE_WORKSPACE_PORT: String(compose.stacks.workspace.ports.http)
  }),
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
        "smoke fixture",
      ]);
      git(repositoryRoot, [
        "worktree",
        "add",
        "--quiet",
        "-b",
        "scope-smoke-linked",
        linkedRoot,
        "main",
      ]);

      const [mainContext, linkedContext] = await Promise.all([
        buildContext({ cwd: repositoryRoot }),
        buildContext({ cwd: linkedRoot }),
      ]);

      expect(mainContext.identity.branch).toBe("main");
      expect(mainContext.identity.isLinkedWorktree).toBe(false);
      expect(linkedContext.identity.branch).toBe("scope-smoke-linked");
      expect(linkedContext.identity.isLinkedWorktree).toBe(true);
      expect(linkedContext.identity.repoKey).toBe(mainContext.identity.repoKey);
      expect(linkedContext.identity.fingerprint).not.toBe(
        mainContext.identity.fingerprint,
      );
      expect(linkedContext.identity.slug).not.toBe(mainContext.identity.slug);

      const engine = await detectEngine();
      expect(engine.name).toBe("docker");
      for (const context of [mainContext, linkedContext]) {
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

      const main = await prepareWorkspace({
        cwd: repositoryRoot,
        startServices: true,
        urlPreference: "direct",
        peekUrl: true,
      });
      const linked = await prepareWorkspace({
        cwd: linkedRoot,
        startServices: true,
        urlPreference: "direct",
        peekUrl: true,
      });

      expect(main.infrastructure.statuses).toHaveLength(3);
      expect(linked.infrastructure.statuses).toHaveLength(3);
      for (const status of [
        ...main.infrastructure.statuses,
        ...linked.infrastructure.statuses,
      ]) {
        expect(status).toEqual(
          expect.objectContaining({ running: true, reachable: true }),
        );
      }

      for (const sharedScope of ["machine", "repository"] as const) {
        expect(stack(linked, sharedScope).rendered.stackId).toBe(
          stack(main, sharedScope).rendered.stackId,
        );
        expect(stack(linked, sharedScope).rendered.ports).toEqual(
          stack(main, sharedScope).rendered.ports,
        );
        expect(stack(linked, sharedScope).directory).toBe(
          stack(main, sharedScope).directory,
        );
      }

      expect(stack(linked, "workspace").rendered.stackId).not.toBe(
        stack(main, "workspace").rendered.stackId,
      );
      expect(stack(linked, "workspace").rendered.ports).not.toEqual(
        stack(main, "workspace").rendered.ports,
      );
      expect(stack(main, "workspace").rendered.projectDirectory).toBe(
        repositoryRoot,
      );
      expect(stack(linked, "workspace").rendered.projectDirectory).toBe(
        linkedRoot,
      );

      const projectIds = new Set(
        [...main.infrastructure.stacks, ...linked.infrastructure.stacks].map(
          ({ stack: candidate }) => candidate.rendered.stackId,
        ),
      );
      expect(projectIds.size).toBe(4);
      for (const projectId of projectIds) {
        const containers = execFileSync(
          engine.cli,
          [
            "ps",
            "--filter",
            `label=com.docker.compose.project=${projectId}`,
            "--format",
            "{{.Names}}",
          ],
          { encoding: "utf8" },
        )
          .trim()
          .split(/\r?\n/)
          .filter(Boolean);
        expect(containers, `running containers for ${projectId}`).toHaveLength(
          1,
        );
      }

      const mainEnv = envSnapshot(main);
      const linkedEnv = envSnapshot(linked);
      expect(linkedEnv.SMOKE_REPO_KEY).toBe(mainEnv.SMOKE_REPO_KEY);
      expect(linkedEnv.SMOKE_MACHINE_PROJECT).toBe(
        mainEnv.SMOKE_MACHINE_PROJECT,
      );
      expect(linkedEnv.SMOKE_MACHINE_PORT).toBe(mainEnv.SMOKE_MACHINE_PORT);
      expect(linkedEnv.SMOKE_REPOSITORY_PROJECT).toBe(
        mainEnv.SMOKE_REPOSITORY_PROJECT,
      );
      expect(linkedEnv.SMOKE_REPOSITORY_PORT).toBe(
        mainEnv.SMOKE_REPOSITORY_PORT,
      );
      expect(linkedEnv.SMOKE_WORKSPACE_SLUG).not.toBe(
        mainEnv.SMOKE_WORKSPACE_SLUG,
      );
      expect(linkedEnv.SMOKE_WORKSPACE_PROJECT).not.toBe(
        mainEnv.SMOKE_WORKSPACE_PROJECT,
      );
      expect(linkedEnv.SMOKE_WORKSPACE_PORT).not.toBe(
        mainEnv.SMOKE_WORKSPACE_PORT,
      );

      const upgradeConfig = fs
        .readFileSync(
          path.join(linkedRoot, "worktrellis.config.mjs"),
          "utf8",
        )
        .replace(
          '{ name: "machine", scope: "machine", files: ["compose.smoke.yml"], ports: port },',
          '{ name: "machine", scope: "machine", files: ["compose.smoke.yml"], ports: port, env: { SMOKE_GENERATION: "two" } },',
        );
      fs.writeFileSync(
        path.join(linkedRoot, "worktrellis.upgrade.config.mjs"),
        upgradeConfig,
      );
      const upgradeContext = await buildContext({
        cwd: linkedRoot,
        configPath: "worktrellis.upgrade.config.mjs",
      });
      const upgradeCandidate = stackFor(
        engine,
        upgradeContext.config.compose[0]!,
        upgradeContext.projectRoot,
        upgradeContext.identity,
        Object.fromEntries(upgradeContext.baseEnv),
      );
      cleanupStacks.set(upgradeCandidate.rendered.stackId, upgradeCandidate);
      const upgraded = await prepareWorkspace({
        cwd: linkedRoot,
        configPath: "worktrellis.upgrade.config.mjs",
        startServices: true,
        allowNewMachineVariants: ["machine"],
        urlPreference: "direct",
        peekUrl: true,
      });
      expect(stack(upgraded, "machine").rendered.stackId).not.toBe(
        stack(main, "machine").rendered.stackId,
      );
      expect(stack(upgraded, "machine").rendered.compatibilityId).toBe(
        stack(upgraded, "machine").rendered.stackId,
      );
    }, 300_000);
  },
);

afterAll(async () => {
  const failures: unknown[] = [];
  for (const candidate of [...cleanupStacks.values()].reverse()) {
    try {
      await candidate.down({ volumes: true });
    } catch (error) {
      failures.push(error);
    }
  }

  vi.unstubAllEnvs();
  if (temporaryRoot) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, "failed to clean up smoke-test stacks");
  }
});
