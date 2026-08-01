import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { afterAll, describe, expect, it, vi } from "vitest";

import { ensureInfrastructure, type EnsureResult } from "../src/platform/stack";
import { detectEngine } from "../src/platform/engine";
import { reconcileMachineLineage } from "../src/platform/lineage";
import type { ComposeStack } from "../src/platform/compose";
import type { WorkspaceIdentity } from "../src/types";
import { realDockerReadiness } from "./real-environment";

const readiness = realDockerReadiness();
if (
  process.env.WORKTRELLIS_COMPOSE_TEST === "1" &&
  !readiness.ready
) {
  process.stderr.write(
    `[worktrellis compose test] skipped: ${readiness.reason}\n`,
  );
}
const temporaryRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "worktrellis-compose-integration-"),
);
let infrastructure: EnsureResult | undefined;
const lineageStacks: ComposeStack[] = [];

const identity: WorkspaceIdentity = {
  root: temporaryRoot,
  repoKey: "compose-test-repo",
  isLinkedWorktree: false,
  branch: "integration",
  head: "test",
  project: "compose-test",
  slug: "integration-deadbeef",
  fingerprint: "deadbeef",
  ports: { app: 3300 },
};

describe.skipIf(!readiness.ready)(
  `real Compose integration${readiness.reason ? ` (skipped: ${readiness.reason})` : ""}`,
  () => {
    it("publishes and probes a project-owned workspace service", async () => {
      vi.stubEnv(
        "WORKTRELLIS_HOME",
        path.join(temporaryRoot, ".worktrellis-home"),
      );
      fs.writeFileSync(
        path.join(temporaryRoot, "compose.worktrellis.yml"),
        [
          "services:",
          "  web:",
          "    image: nginx:alpine",
          "    restart: unless-stopped",
          "",
        ].join("\n"),
      );

      infrastructure = await ensureInfrastructure(
        [
          {
            name: "web",
            scope: "workspace",
            files: ["compose.worktrellis.yml"],
            ports: {
              http: {
                service: "web",
                containerPort: 80,
                probe: { kind: "http", path: "/" },
              },
            },
          },
        ],
        {
          identity,
          projectRoot: temporaryRoot,
          startIfStopped: true,
        },
      );

      expect(infrastructure.statuses).toEqual([
        expect.objectContaining({
          name: "web",
          scope: "workspace",
          running: true,
          reachable: true,
        }),
      ]);
      expect(infrastructure.compose.url("web", "http")).toMatch(
        /^http:\/\/127\.0\.0\.1:\d+$/,
      );
    }, 180_000);

    it("rejects host ports published by the project Compose file", async () => {
      fs.writeFileSync(
        path.join(temporaryRoot, "compose.invalid.yml"),
        [
          "services:",
          "  web:",
          "    image: nginx:alpine",
          '    ports: ["127.0.0.1:18080:80"]',
          "",
        ].join("\n"),
      );

      await expect(
        ensureInfrastructure(
          [
            {
              name: "invalid",
              scope: "workspace",
              files: ["compose.invalid.yml"],
              ports: {
                http: { service: "web", containerPort: 80 },
              },
            },
          ],
          {
            identity,
            projectRoot: temporaryRoot,
            startIfStopped: true,
          },
        ),
      ).rejects.toThrow(/publish host ports/);
    }, 60_000);

    it("reconciles a definition-only change onto the same machine volume", async () => {
      const root = fs.mkdtempSync(
        path.join(temporaryRoot, "lineage-"),
      );
      const home = path.join(root, "home");
      vi.stubEnv("WORKTRELLIS_HOME", home);
      const composeFile = path.join(root, "compose.yml");
      const writeCompose = (
        comment: string,
        preserve = false,
        unhealthy = false,
      ) =>
        fs.writeFileSync(
          composeFile,
          [
            `# ${comment}`,
            "services:",
            "  keeper:",
            "    image: alpine:3.20",
            preserve
              ? '    command: ["sh", "-c", "test -f /data/sentinel || echo retained > /data/sentinel; sleep 600"]'
              : '    command: ["sh", "-c", "echo retained > /data/sentinel && sleep 600"]',
            ...(unhealthy
              ? [
                  "    healthcheck:",
                  '      test: ["CMD", "false"]',
                  "      interval: 1s",
                  "      timeout: 1s",
                  "      retries: 2",
                ]
              : []),
            "    volumes:",
            "      - keeper_data:/data",
            "volumes:",
            "  keeper_data:",
            "",
          ].join("\n"),
        );
      writeCompose("first definition");
      const spec = {
        name: "lineage",
        scope: "machine" as const,
        files: ["compose.yml"],
        volumeDataVersions: { keeper_data: "alpine-data-1" },
      };
      const lineageIdentity = { ...identity, root, slug: "lineage-feedface" };
      const first = await ensureInfrastructure([spec], {
        identity: lineageIdentity,
        projectRoot: root,
        startIfStopped: true,
      });
      const firstStack = first.stacks[0]!.stack;
      lineageStacks.push(firstStack);
      const sourceProject = firstStack.rendered.stackId;
      const volumeBefore = execFileSync(
        "docker",
        [
          "inspect",
          `${sourceProject}-keeper-1`,
          "--format",
          "{{range .Mounts}}{{if eq .Destination \"/data\"}}{{.Name}}{{end}}{{end}}",
        ],
        { encoding: "utf8" },
      ).trim();

      writeCompose("compatible command change", true);
      await expect(
        ensureInfrastructure([spec], {
          identity: lineageIdentity,
          projectRoot: root,
          startIfStopped: true,
          interactive: false,
        }),
      ).rejects.toMatchObject({ code: 4 });

      const engine = await detectEngine();
      const reconciled = await reconcileMachineLineage({
        engine,
        spec,
        projectRoot: root,
        identity: lineageIdentity,
        baseEnv: {},
        sourceProject,
      });
      expect(reconciled.stackId).toBe(sourceProject);
      const after = await ensureInfrastructure([spec], {
        identity: lineageIdentity,
        projectRoot: root,
        startIfStopped: true,
        interactive: false,
      });
      lineageStacks.push(after.stacks[0]!.stack);
      expect(after.stacks[0]!.stack.rendered.stackId).toBe(sourceProject);
      expect(
        execFileSync(
          "docker",
          ["exec", `${sourceProject}-keeper-1`, "cat", "/data/sentinel"],
          { encoding: "utf8" },
        ).trim(),
      ).toBe("retained");
      const volumeAfter = execFileSync(
        "docker",
        [
          "inspect",
          `${sourceProject}-keeper-1`,
          "--format",
          "{{range .Mounts}}{{if eq .Destination \"/data\"}}{{.Name}}{{end}}{{end}}",
        ],
        { encoding: "utf8" },
      ).trim();
      expect(volumeAfter).toBe(volumeBefore);

      writeCompose("unhealthy definition", true, true);
      await expect(
        reconcileMachineLineage({
          engine,
          spec,
          projectRoot: root,
          identity: lineageIdentity,
          baseEnv: {},
          sourceProject,
        }),
      ).rejects.toThrow(/reach Compose health/);
      expect(
        execFileSync(
          "docker",
          ["exec", `${sourceProject}-keeper-1`, "cat", "/data/sentinel"],
          { encoding: "utf8" },
        ).trim(),
      ).toBe("retained");
      expect(
        execFileSync(
          "docker",
          [
            "inspect",
            `${sourceProject}-keeper-1`,
            "--format",
            "{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}",
          ],
          { encoding: "utf8" },
        ).trim(),
      ).toBe("none");
    }, 240_000);
  },
);

afterAll(async () => {
  if (infrastructure) {
    await Promise.all(
      infrastructure.stacks.map(({ stack }) =>
        stack.down({ volumes: true }),
      ),
    );
  }
  for (const stack of lineageStacks.reverse()) {
    await stack.down({ volumes: true }).catch(() => undefined);
  }
  vi.unstubAllEnvs();
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}, 180_000);
