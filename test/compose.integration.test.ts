import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { ensureInfrastructure, type EnsureResult } from "../src/platform/stack";
import type { WorkspaceIdentity } from "../src/types";

const enabled = process.env.WORKTRELLIS_COMPOSE_TEST === "1";
const temporaryRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "worktrellis-compose-integration-"),
);
let infrastructure: EnsureResult | undefined;

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

describe.skipIf(!enabled)("real Compose integration", () => {
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
});

afterAll(async () => {
  if (infrastructure) {
    await Promise.all(
      infrastructure.stacks.map(({ stack }) =>
        stack.down({ volumes: true }),
      ),
    );
  }
  vi.unstubAllEnvs();
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});
