import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { endpointDoctorCheck } from "../src/commands/doctor";
import { resolveInfoComposeProjects } from "../src/commands/info";
import {
  buildStatusJson,
  classifyRuntimeState,
  resolvePackageManager,
} from "../src/commands/misc";
import { includesAppPortProcess } from "../src/commands/up";
import { runSelfCheck } from "../src/commands/self-check";
import { parseArgs } from "../src/core/args";
import { loadConfig } from "../src/core/config";
import { buildContext } from "../src/core/context";
import { redactDiagnosticText, resolveEnv } from "../src/core/env-resolve";
import { loadWorkspaceLocalConfig } from "../src/core/local-config";
import { renderStack } from "../src/platform/compose-render";
import {
  endpointForDockerContext,
  hostForUrl,
  normalizeBindAddress,
  normalizeConnectHost,
} from "../src/platform/engine-endpoint";
import { probePort } from "../src/platform/health";
import { publicationConflicts } from "../src/platform/port-owner";
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
import {
  mergeManagedProcessEnvironment,
  spawnManagedProcess,
  type ManagedProcess,
} from "../src/supervise/managed-process";
import {
  buildWindowsEnvironmentBlock,
  describeWindowsError,
  quoteWindowsArgument,
  resolveWindowsExecutable,
} from "../src/supervise/windows-job-process";
import {
  normalizeProcessCommandLine,
  readRunRecord,
  reapApplicationPort,
  reapOrphans,
  writeRunRecord,
  type RunRecord,
} from "../src/supervise/reaper";
import {
  requestGracefulShutdown,
  verifySupervisorForShutdown,
  waitForProcessExit,
} from "../src/supervise/shutdown";
import {
  isProcessAlive,
  killTree,
  parseProcessIds,
  parseWindowsListeningProcessIds,
} from "../src/util/proc";
import { waitForPortClose } from "../src/platform/ports";
import { sha256 } from "../src/util/hash";
import { resolveUrl } from "../src/url/provider";
import {
  parsePortlessSharingUrl,
  PORTLESS_TAILSCALE_CLEANUP_GRACE_MS,
  quoteWindowsCmdToken,
  supportsReliablePortlessTailscale,
  wrapCommandForPortless,
} from "../src/url/portless";
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

async function waitForFile(file: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!fs.existsSync(file)) {
    throw new Error(`timed out waiting for ${file}`);
  }
}

function collectManagedStream(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (!stream) return Promise.resolve("");
  return new Promise((resolve, reject) => {
    let output = "";
    stream.on("data", (chunk) => {
      output += String(chunk);
    });
    stream.once("error", reject);
    stream.once("end", () => resolve(output));
  });
}

function waitForManagedExit(managed: ManagedProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    managed.onceError(reject);
    managed.onceExit(resolve);
  });
}

async function startTestPortOwner(
  directory: string,
  label: string,
): Promise<{ wrapperPid: number; childPid: number; port: number }> {
  const ownerDirectory = path.join(directory, label);
  fs.mkdirSync(ownerDirectory, { recursive: true });
  const wrapperFile = path.join(ownerDirectory, "wrapper.cjs");
  const childPidFile = path.join(ownerDirectory, "child.pid");
  const portFile = path.join(ownerDirectory, "port");
  fs.writeFileSync(
    wrapperFile,
    `const { spawn } = require("node:child_process");
const fs = require("node:fs");
const child = spawn(process.execPath, [
  "-e",
  ${JSON.stringify(`const fs = require("node:fs"); const server = require("node:net").createServer(); server.listen(0, "127.0.0.1", () => fs.writeFileSync(${JSON.stringify(portFile)}, String(server.address().port)));`)},
], { stdio: "ignore" });
fs.writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid));
setInterval(() => {}, 1000);
`,
  );

  const wrapper = spawn(process.execPath, [wrapperFile], {
    detached: process.platform !== "win32",
    stdio: "ignore",
  });
  await waitForFile(childPidFile);
  await waitForFile(portFile);

  return {
    wrapperPid: wrapper.pid!,
    childPid: Number(fs.readFileSync(childPidFile, "utf8")),
    port: Number(fs.readFileSync(portFile, "utf8")),
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
      configVersion: 3,
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

  it("redacts exact secret values and URL credentials from diagnostics", () => {
    const secret = "worktrellis-sentinel-secret";
    const value = redactDiagnosticText(
      `token=${secret} database=postgresql://user:p%40ss@127.0.0.1/db callback=https://example.test/cb?access_token=query-secret`,
      {
        API_TOKEN: secret,
        DATABASE_URL: "postgresql://user:p%40ss@127.0.0.1/db",
      },
    );

    expect(value).not.toContain(secret);
    expect(value).not.toContain("p%40ss");
    expect(value).not.toContain("query-secret");
    expect(value).toContain("postgresql://user:***@127.0.0.1/db");
    expect(value).toContain("access_token=***");
  });
});

describe("WorkTrellis diagnostic JSON", () => {
  it("omits private paths, provider environment, and raw resources", () => {
    const secret = "worktrellis-status-sentinel";
    const resourceAdapters = {
      database: defineResourceAdapter<{
        database: string;
        password: string;
        url: string;
      }>({
        kind: "test-database",
        isolation: "database",
        endpoint: { stack: "local", port: "database" },
        resolve: () => ({
          database: "safe_database",
          password: secret,
          url: `postgresql://user:${secret}@127.0.0.1/safe_database`,
        }),
        describe: (resource) =>
          `database ${resource.database} at ${resource.url} using ${resource.password}`,
      }),
    };

    const result = buildStatusJson({
      workspace: identity({ root: "/private/worktree/path" }),
      running: true,
      orphaned: false,
      state: "running",
      url: {
        mode: "portless",
        appUrl: "https://test.localhost",
        rootDomain: "localhost",
        cookieDomain: ".localhost",
        tenantUrlTemplate: "https://<subdomain>.test.localhost",
        wildcardOrigins: ["https://*.test.localhost"],
        listenHost: "127.0.0.1",
        listenPort: 3210,
        sharingUrl: "https://node.example.ts.net:8443",
        fallbackReason: `proxy rejected token ${secret}`,
        providerEnv: {
          NODE_EXTRA_CA_CERTS: "/private/portless/ca.pem",
        },
      },
      compose: [
        {
          name: "local",
        scope: "machine",
        stackId: "worktrellis-machine-local",
        compatibilityId: "worktrellis-machine-local",
          ports: { database: 5432 },
          running: true,
          reachable: false,
          detail: `postgresql://user:${secret}@127.0.0.1/db`,
        },
      ],
      resourceAdapters,
      resources: {
        database: {
          database: "safe_database",
          password: secret,
          url: `postgresql://user:${secret}@127.0.0.1/safe_database`,
        },
      },
    });
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("/private/worktree/path");
    expect(result.url.sharingUrl).toBe("https://node.example.ts.net:8443");
    expect(serialized).not.toContain("NODE_EXTRA_CA_CERTS");
    expect(serialized).not.toContain("/private/portless/ca.pem");
    expect(result.url.fallbackReason).toBe("proxy rejected token ***");
    expect(result.resources).toEqual([
      {
        name: "database",
        kind: "test-database",
        detail:
          "database safe_database at postgresql://user:***@127.0.0.1/safe_database using ***",
      },
    ]);
  });
});

describe("WorkTrellis package boundary", () => {
  it("keeps host-project vocabulary out of package source", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(runSelfCheck()).toBe(0);
  });

  it("runs the npm bin in-process so Windows shutdown can finish", () => {
    const launcher = fs.readFileSync(
      path.join(process.cwd(), "bin", "worktrellis.mjs"),
      "utf8",
    );

    expect(launcher).toContain('import("tsx/esm/api")');
    expect(launcher).not.toContain("node:child_process");
  });
});

describe("WorkTrellis process supervision", () => {
  it("normalizes escaped Windows paths for ownership verification", () => {
    expect(
      normalizeProcessCommandLine(
        String.raw`node.exe -e "D:\\a\\WorkTrellis\\WorkTrellis\\child.js"`,
      ),
    ).toContain("d:/a/worktrellis/worktrellis/child.js");
  });

  it("quotes Windows process arguments without involving a shell", () => {
    expect(quoteWindowsArgument("plain")).toBe("plain");
    expect(quoteWindowsArgument("")).toBe('""');
    expect(quoteWindowsArgument("two words")).toBe('"two words"');
    expect(quoteWindowsArgument("C:\\Program Files\\node\\")).toBe(
      '"C:\\Program Files\\node\\\\"',
    );
    expect(quoteWindowsArgument('say "hello"')).toBe(
      '"say \\"hello\\""',
    );
    expect(() => quoteWindowsArgument("bad\0argument")).toThrow(
      "cannot contain null characters",
    );
  });

  it("merges Windows environment layers case-insensitively with later values winning", () => {
    expect(
      mergeManagedProcessEnvironment(
        [
          { Path: "C:\\Inherited", TEMP: "base" },
          { PATH: "C:\\Configured", temp: "override" },
        ],
        true,
      ),
    ).toEqual({ PATH: "C:\\Configured", temp: "override" });
  });

  it("builds an ordinally sorted and case-normalized Windows environment block", () => {
    const block = buildWindowsEnvironmentBlock({
      Zebra: "last",
      alpha: "first",
      "=C:": "C:\\workspace",
      _WT: "underscore",
      "[WT": "bracket",
      "ÄVAR": "unicode",
      Path: "C:\\Inherited",
      PATH: "C:\\Configured",
      "bad=name": "ignored",
    });
    expect(block.toString("utf16le")).toBe(
      "=C:=C:\\workspace\0alpha=first\0PATH=C:\\Configured\0Zebra=last\0[WT=bracket\0_WT=underscore\0ÄVAR=unicode\0\0",
    );
  });

  it("translates common Windows native process errors", () => {
    expect(describeWindowsError(5)).toBe("access denied (5)");
    expect(describeWindowsError(193)).toBe(
      "not a valid Windows executable (193)",
    );
    expect(describeWindowsError(12345)).toBe("Win32 error (12345)");
  });

  it("resolves only a real Windows executable from PATH and PATHEXT", () => {
    vi.spyOn(fs, "existsSync").mockImplementation(
      (candidate) => String(candidate) === "C:\\Tools\\node.EXE",
    );
    expect(
      resolveWindowsExecutable("node", "C:\\workspace", {
        Path: "C:\\Tools",
        PATHEXT: ".EXE;.CMD",
      }),
    ).toBe("C:\\Tools\\node.EXE");
    expect(() =>
      resolveWindowsExecutable("script.cmd", "C:\\workspace", {
        Path: "C:\\Tools",
        PATHEXT: ".EXE;.CMD",
      }),
    ).toThrow("could not resolve executable");
  });

  it("uses the final case-insensitive PATH value to resolve Windows executables", () => {
    vi.spyOn(fs, "existsSync").mockImplementation(
      (candidate) => String(candidate) === "C:\\Configured\\tool.EXE",
    );
    expect(
      resolveWindowsExecutable("tool", "C:\\workspace", {
        Path: "C:\\Inherited",
        PATH: "C:\\Configured",
        PATHEXT: ".EXE",
      }),
    ).toBe("C:\\Configured\\tool.EXE");
  });

  it.runIf(process.platform === "win32")(
    "resolves the active Windows Node executable without a shell",
    () => {
      expect(
        resolveWindowsExecutable(process.execPath, process.cwd(), process.env),
      ).toBe(process.execPath);
    },
  );

  it.runIf(process.platform === "win32")(
    "launches without a console and preserves arguments and separate output pipes",
    async () => {
      const directory = path.join(
        temporaryDirectory("worktrellis-native-launch"),
        "folder with spaces & symbols",
      );
      fs.mkdirSync(directory, { recursive: true });
      const script = path.join(directory, "inspect child.cjs");
      const koffiPath = path.join(process.cwd(), "node_modules", "koffi");
      fs.writeFileSync(
        script,
        `const koffi = require(${JSON.stringify(koffiPath)});
const kernel32 = koffi.load("kernel32.dll");
const GetConsoleWindow = kernel32.func("__stdcall", "GetConsoleWindow", "void *", []);
process.stdout.write(JSON.stringify({ console: Boolean(GetConsoleWindow()), argv: process.argv.slice(2), sentinel: process.env.WORKTRELLIS_NATIVE_SENTINEL }) + "\\n");
process.stderr.write("native-stderr-complete\\n");
`,
      );
      const expectedArguments = [
        "two words & ^ < > | ( ) % !",
        'embedded "quote" and trailing slash\\',
      ];
      const managed = await spawnManagedProcess({
        file: process.execPath,
        args: [script, ...expectedArguments],
        cwd: directory,
        env: {
          ...process.env,
          WORKTRELLIS_NATIVE_SENTINEL: "present",
        },
      });
      const stdout = collectManagedStream(managed.stdout);
      const stderr = collectManagedStream(managed.stderr);

      await expect(waitForManagedExit(managed)).resolves.toBe(0);
      expect(JSON.parse((await stdout).trim())).toEqual({
        console: false,
        argv: expectedArguments,
        sentinel: "present",
      });
      expect(await stderr).toBe("native-stderr-complete\n");
    },
    15_000,
  );

  it.runIf(process.platform === "win32")(
    "reports exit code 259 after the managed process has terminated",
    async () => {
      const managed = await spawnManagedProcess({
        file: process.execPath,
        args: ["-e", "process.exit(259)"],
        cwd: process.cwd(),
        env: { ...process.env },
      });

      await expect(waitForManagedExit(managed)).resolves.toBe(259);
    },
    15_000,
  );

  it.runIf(process.platform === "win32")(
    "force-terminates nested listeners in the Job and permits an immediate restart",
    async () => {
      const directory = temporaryDirectory("worktrellis-native-force");
      const observedPids: number[] = [];

      for (const attempt of [1, 2]) {
        const attemptDirectory = path.join(directory, `attempt-${attempt}`);
        fs.mkdirSync(attemptDirectory, { recursive: true });
        const wrapperFile = path.join(attemptDirectory, "wrapper.cjs");
        const childPidFile = path.join(attemptDirectory, "child.pid");
        const portFile = path.join(attemptDirectory, "port");
        const listener = `const fs = require("node:fs");
const server = require("node:net").createServer(() => {});
server.listen(0, "127.0.0.1", () => fs.writeFileSync(${JSON.stringify(portFile)}, String(server.address().port)));
setInterval(() => {}, 1000);`;
        fs.writeFileSync(
          wrapperFile,
          `const { spawn } = require("node:child_process");
const fs = require("node:fs");
const child = spawn(process.execPath, ["-e", ${JSON.stringify(listener)}], { stdio: "ignore" });
fs.writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid));
setInterval(() => {}, 1000);
`,
        );

        const managed = await spawnManagedProcess({
          file: process.execPath,
          args: [wrapperFile],
          cwd: attemptDirectory,
          env: { ...process.env },
        });
        const completion = waitForManagedExit(managed);
        await waitForFile(childPidFile);
        await waitForFile(portFile);
        const childPid = Number(fs.readFileSync(childPidFile, "utf8"));
        const port = Number(fs.readFileSync(portFile, "utf8"));
        observedPids.push(managed.pid!, childPid);

        expect(managed.forceTerminate(1)).toBe(true);
        await expect(completion).resolves.not.toBe(0);
        await expect(
          waitForProcessExit(childPid, { timeoutMs: 5_000 }),
        ).resolves.toBe(true);
        await expect(waitForPortClose(port, { timeoutMs: 5_000 })).resolves.toBe(
          true,
        );
      }

      expect(new Set(observedPids).size).toBe(observedPids.length);
    },
    30_000,
  );

  it.runIf(process.platform === "win32")(
    "closes the Job and its listener tree when the owning supervisor exits abruptly",
    async () => {
      const directory = temporaryDirectory("worktrellis-native-abrupt");
      const wrapperFile = path.join(directory, "wrapper.cjs");
      const ownerFile = path.join(directory, "owner.mjs");
      const rootPidFile = path.join(directory, "root.pid");
      const childPidFile = path.join(directory, "child.pid");
      const portFile = path.join(directory, "port");
      const listener = `const fs = require("node:fs");
const server = require("node:net").createServer(() => {});
server.listen(0, "127.0.0.1", () => fs.writeFileSync(${JSON.stringify(portFile)}, String(server.address().port)));
setInterval(() => {}, 1000);`;
      fs.writeFileSync(
        wrapperFile,
        `const { spawn } = require("node:child_process");
const fs = require("node:fs");
const child = spawn(process.execPath, ["-e", ${JSON.stringify(listener)}], { stdio: "ignore" });
fs.writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid));
setInterval(() => {}, 1000);
`,
      );
      const managedProcessUrl = pathToFileURL(
        path.join(process.cwd(), "src", "supervise", "managed-process.ts"),
      ).href;
      fs.writeFileSync(
        ownerFile,
        `import fs from "node:fs";
import { spawnManagedProcess } from ${JSON.stringify(managedProcessUrl)};
const managed = await spawnManagedProcess({
  file: process.execPath,
  args: [${JSON.stringify(wrapperFile)}],
  cwd: ${JSON.stringify(directory)},
  env: { ...process.env },
});
fs.writeFileSync(${JSON.stringify(rootPidFile)}, String(managed.pid));
setInterval(() => {}, 1000);
`,
      );

      const owner = spawn(process.execPath, ["--import", "tsx", ownerFile], {
        cwd: process.cwd(),
        stdio: "ignore",
        windowsHide: true,
      });
      let rootPid: number | undefined;
      let childPid: number | undefined;
      try {
        await waitForFile(rootPidFile, 10_000);
        await waitForFile(childPidFile, 10_000);
        await waitForFile(portFile, 10_000);
        rootPid = Number(fs.readFileSync(rootPidFile, "utf8"));
        childPid = Number(fs.readFileSync(childPidFile, "utf8"));
        const port = Number(fs.readFileSync(portFile, "utf8"));

        process.kill(owner.pid!, "SIGKILL");
        await expect(
          waitForProcessExit(owner.pid!, { timeoutMs: 5_000 }),
        ).resolves.toBe(true);
        await expect(
          waitForProcessExit(rootPid, { timeoutMs: 5_000 }),
        ).resolves.toBe(true);
        await expect(
          waitForProcessExit(childPid, { timeoutMs: 5_000 }),
        ).resolves.toBe(true);
        await expect(waitForPortClose(port, { timeoutMs: 5_000 })).resolves.toBe(
          true,
        );
      } finally {
        if (owner.pid && isProcessAlive(owner.pid)) process.kill(owner.pid, "SIGKILL");
        if (rootPid && isProcessAlive(rootPid)) killTree(rootPid, "SIGKILL");
        if (childPid && isProcessAlive(childPid)) killTree(childPid, "SIGKILL");
      }
    },
    30_000,
  );

  it("parses IPv4 and IPv6 Windows listeners without matching adjacent ports", () => {
    const output = [
      "  TCP    0.0.0.0:3202      0.0.0.0:0      LISTENING       19428",
      "  TCP    [::]:3202         [::]:0         LISTENING       19428",
      "  TCP    127.0.0.1:13202   0.0.0.0:0      LISTENING       29124",
      "  TCP    127.0.0.1:3202    127.0.0.1:5000 ESTABLISHED     7480",
    ].join("\r\n");

    expect(parseWindowsListeningProcessIds(output, 3202)).toEqual([19428]);
  });

  it("parses unique listener PIDs returned by Windows PowerShell", () => {
    expect(parseProcessIds("19428\r\n19428\r\n29124\r\n")).toEqual([
      19428, 29124,
    ]);
  });

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

  it(
    "lets an orphaned wrapper perform provider cleanup before force escalation",
    async () => {
      const directory = temporaryDirectory("worktrellis-orphan-cleanup");
      const wrapperFile = path.join(directory, "wrapper.cjs");
      const readyMarker = path.join(directory, "ready");
      const cleanupMarker = path.join(directory, "cleanup-complete");
      const runFile = path.join(directory, "run.json");

      fs.writeFileSync(
        wrapperFile,
        `const { spawn } = require("node:child_process");
const fs = require("node:fs");
const child = spawn(process.execPath, [
  "-e",
  "setInterval(() => {}, 1000)"
], { stdio: "ignore" });
fs.writeFileSync(${JSON.stringify(readyMarker)}, "ready");
let stopping = false;
const finish = () => {
  if (stopping) return;
  stopping = true;
  fs.writeFileSync(${JSON.stringify(cleanupMarker)}, "done");
  process.exit(0);
};
child.once("exit", finish);
process.on("SIGTERM", () => {
  try { process.kill(child.pid, "SIGTERM"); } catch {}
  setTimeout(finish, 200);
});
setInterval(() => {}, 1000);
`,
      );

      const wrapper = spawn(process.execPath, [wrapperFile], {
        detached: process.platform !== "win32",
        stdio: "ignore",
      });

      try {
        await waitForFile(readyMarker);
        writeRunRecord(runFile, {
          supervisorPid: process.pid,
          supervisorStartedAt: Date.now(),
          project: "test",
          slug: "test",
          worktreeRoot: directory,
          aliases: [],
          children: [
            {
              name: "app",
              pid: wrapper.pid!,
              startedAtMs: Date.now(),
              cmdMustContain: directory,
            },
          ],
        });

        const result = await reapOrphans(runFile, { graceMs: 1_000 });
        expect(result.blocked).toEqual([]);
        expect(result.stopped).toEqual([
          { name: "app", pid: wrapper.pid, forced: false },
        ]);
        expect(fs.readFileSync(cleanupMarker, "utf8")).toBe("done");
        expect(fs.existsSync(runFile)).toBe(false);
      } finally {
        if (wrapper.pid && isProcessAlive(wrapper.pid)) {
          killTree(wrapper.pid, "SIGKILL");
        }
      }
    },
  );

  it(
    "recovers verified port owners with retained state or explicit force",
    async () => {
      const directory = temporaryDirectory("worktrellis-port-owner");
      const owners: Array<{ wrapperPid: number; childPid: number }> = [];

      try {
        const retained = await startTestPortOwner(directory, "retained");
        owners.push(retained);
        const recorded = await reapApplicationPort(retained.port, directory, {
          record: {
            supervisorPid: process.pid,
            supervisorStartedAt: Date.now(),
            project: "test",
            slug: "test",
            worktreeRoot: directory,
            aliases: [],
            children: [
              {
                name: "app",
                pid: retained.wrapperPid,
                startedAtMs: Date.now(),
                cmdMustContain: directory,
              },
            ],
          },
        });
        expect(recorded.blocked).toEqual([]);
        expect(recorded.stopped).toEqual([{ pid: retained.wrapperPid }]);
        await expect(
          waitForProcessExit(retained.childPid, { timeoutMs: 2_000 }),
        ).resolves.toBe(true);

        const lost = await startTestPortOwner(directory, "lost");
        owners.push(lost);
        const guarded = await reapApplicationPort(lost.port, directory);
        expect(guarded.stopped).toEqual([]);
        expect(guarded.blocked).toEqual([
          expect.objectContaining({
            pid: lost.childPid,
            reason: expect.stringContaining("--force"),
          }),
        ]);
        expect(isProcessAlive(lost.wrapperPid)).toBe(true);
        expect(isProcessAlive(lost.childPid)).toBe(true);

        const recovered = await reapApplicationPort(lost.port, directory, {
          allowUnrecorded: true,
        });
        expect(recovered.blocked).toEqual([]);
        expect(recovered.stopped).toEqual([{ pid: lost.wrapperPid }]);
        await expect(
          waitForProcessExit(lost.wrapperPid, { timeoutMs: 2_000 }),
        ).resolves.toBe(true);
        await expect(
          waitForProcessExit(lost.childPid, { timeoutMs: 2_000 }),
        ).resolves.toBe(true);
      } finally {
        for (const owner of owners) {
          if (isProcessAlive(owner.wrapperPid)) {
            killTree(owner.wrapperPid, "SIGKILL");
          }
          if (isProcessAlive(owner.childPid)) {
            killTree(owner.childPid, "SIGKILL");
          }
        }
      }
    },
    30_000,
  );

  it(
    "lets a supervised wrapper finish graceful descendant cleanup",
    async () => {
      const directory = temporaryDirectory("worktrellis-graceful-shutdown");
      const wrapperFile = path.join(directory, "wrapper.cjs");
      const childPidFile = path.join(directory, "child.pid");
      const cleanupMarker = path.join(directory, "cleanup-complete");
      const runFile = path.join(directory, "run.json");
      const stopFile = path.join(directory, "stop.json");

      fs.writeFileSync(
        wrapperFile,
        `const { spawn } = require("node:child_process");
const fs = require("node:fs");
const child = spawn(process.execPath, [
  "-e",
  "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)"
], { detached: process.platform !== "win32", stdio: "ignore" });
fs.writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid));
let stopping = false;
const finish = () => {
  if (stopping) return;
  stopping = true;
  fs.writeFileSync(${JSON.stringify(cleanupMarker)}, "done");
  process.exit(0);
};
child.once("exit", finish);
process.on("SIGTERM", () => {
  try { process.kill(-child.pid, "SIGTERM"); } catch {}
  try { process.kill(child.pid, "SIGTERM"); } catch {}
  setTimeout(finish, 200);
});
setInterval(() => {}, 1000);
`,
      );

      const supervisor = new Supervisor({
        projectRoot: directory,
        env: {},
        envContext: {} as EnvContext,
        runFile,
        stopFile,
        logDirectory: path.join(directory, "logs"),
        identity: { project: "test", slug: "test", root: directory },
        aliases: [],
      });
      supervisor.add(
        {
          name: "wrapper",
          command: { bin: process.execPath, args: [wrapperFile] },
        },
        0,
      );

      const completion = supervisor.run();
      let childPid: number | undefined;
      try {
        await waitForFile(childPidFile);
        childPid = Number(fs.readFileSync(childPidFile, "utf8"));
        const record = readRunRecord(runFile);
        expect(record).not.toBeNull();

        requestGracefulShutdown(stopFile, {
          supervisorPid: record!.supervisorPid,
          supervisorStartedAt: record!.supervisorStartedAt + 1,
        });
        await new Promise((resolve) => setTimeout(resolve, 250));
        expect(fs.existsSync(cleanupMarker)).toBe(false);

        requestGracefulShutdown(stopFile, record!);
        await expect(completion).resolves.toBe(0);
        expect(fs.readFileSync(cleanupMarker, "utf8")).toBe("done");
        await expect(
          waitForProcessExit(childPid, { timeoutMs: 2_000 }),
        ).resolves.toBe(true);
      } finally {
        await supervisor.shutdown();
        if (childPid && isProcessAlive(childPid)) {
          killTree(childPid, "SIGKILL");
        }
      }
    },
    10_000,
  );

  it("verifies the recorded supervisor incarnation before shutdown", async () => {
    const directory = temporaryDirectory("worktrellis-supervisor-verification");
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)", "worktrellis-supervisor"],
      {
        detached: process.platform !== "win32",
        stdio: "ignore",
      },
    );
    const startedAt = Date.now();

    try {
      expect(child.pid).toBeTypeOf("number");
      const record: RunRecord = {
        supervisorPid: child.pid!,
        supervisorStartedAt: startedAt,
        project: "test",
        slug: "test-workspace",
        worktreeRoot: directory,
        aliases: [],
        children: [],
      };

      expect(
        verifySupervisorForShutdown(record, {
          pid: child.pid!,
          startedAt: new Date(startedAt).toISOString(),
          project: "test",
          slug: "test-workspace",
          worktreeRoot: directory,
        }),
      ).toEqual({ verified: true });
      expect(
        verifySupervisorForShutdown(record, {
          pid: child.pid!,
          startedAt: new Date(startedAt).toISOString(),
          project: "test",
          slug: "another-workspace",
          worktreeRoot: directory,
        }),
      ).toEqual({
        verified: false,
        reason: "the run record belongs to another workspace",
      });
    } finally {
      if (child.pid) killTree(child.pid, "SIGKILL");
      await waitForProcessExit(child.pid!, { timeoutMs: 2_000 });
    }
  });

  it("force-kills descendants that created their own process groups", async () => {
    const directory = temporaryDirectory("worktrellis-force-tree");
    const wrapperFile = path.join(directory, "wrapper.cjs");
    const childPidFile = path.join(directory, "child.pid");
    fs.writeFileSync(
      wrapperFile,
      `const { spawn } = require("node:child_process");
const fs = require("node:fs");
const child = spawn(process.execPath, [
  "-e",
  "setInterval(() => {}, 1000)"
], { detached: process.platform !== "win32", stdio: "ignore" });
fs.writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid));
setInterval(() => {}, 1000);
`,
    );
    const wrapper = spawn(process.execPath, [wrapperFile], {
      detached: process.platform !== "win32",
      stdio: "ignore",
    });
    let childPid: number | undefined;

    try {
      await waitForFile(childPidFile);
      childPid = Number(fs.readFileSync(childPidFile, "utf8"));
      expect(isProcessAlive(wrapper.pid!)).toBe(true);
      expect(isProcessAlive(childPid)).toBe(true);

      killTree(wrapper.pid!, "SIGKILL");

      await expect(
        waitForProcessExit(wrapper.pid!, { timeoutMs: 2_000 }),
      ).resolves.toBe(true);
      await expect(
        waitForProcessExit(childPid, { timeoutMs: 2_000 }),
      ).resolves.toBe(true);
    } finally {
      if (wrapper.pid && isProcessAlive(wrapper.pid)) {
        killTree(wrapper.pid, "SIGKILL");
      }
      if (childPid && isProcessAlive(childPid)) {
        killTree(childPid, "SIGKILL");
      }
    }
  });

  it("rejects dependency cycles while loading configuration", async () => {
    const directory = temporaryDirectory("worktrellis-config");
    const configPath = path.join(directory, "worktrellis.config.mjs");
    fs.writeFileSync(
      configPath,
      `export default {
        configVersion: 3,
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
      /requires `configVersion: 3`/,
    );
  });
});

describe("WorkTrellis scoped Compose plans", () => {
  it("resolves machine-local addresses for one Docker context", () => {
    const context = {
      name: "parallels-windows",
      endpoint: "tcp://10.211.55.4:2375",
      isRemote: true,
    };
    const defaults = endpointForDockerContext(context, {});
    expect(defaults).toMatchObject({
      contextName: "parallels-windows",
      bindAddress: "127.0.0.1",
      connectHost: "127.0.0.1",
      configured: false,
      stale: false,
    });

    const configured = endpointForDockerContext(context, {
      dockerContexts: {
        "parallels-windows": {
          endpointFingerprint: sha256(context.endpoint),
          bindAddress: "0.0.0.0",
          connectHost: "windows-docker.test",
        },
      },
    });
    expect(configured).toMatchObject({
      bindAddress: "0.0.0.0",
      connectHost: "windows-docker.test",
      configured: true,
      stale: false,
    });

    const stale = endpointForDockerContext(context, {
      dockerContexts: {
        "parallels-windows": {
          endpointFingerprint: sha256("tcp://10.211.55.3:2375"),
          bindAddress: "10.211.55.3",
          connectHost: "10.211.55.3",
        },
      },
    });
    expect(stale.stale).toBe(true);
  });

  it("validates bind and connect addresses without conflating them", () => {
    expect(normalizeBindAddress(" 0.0.0.0 ")).toBe("0.0.0.0");
    expect(normalizeBindAddress("::1")).toBe("::1");
    expect(normalizeConnectHost(" Docker-VM.Test ")).toBe("docker-vm.test");
    expect(hostForUrl("2001:db8::1")).toBe("[2001:db8::1]");
    expect(() => normalizeBindAddress("docker-vm.test")).toThrow(/IPv4 or IPv6/);
    expect(() => normalizeConnectHost("0.0.0.0")).toThrow(/reachable host/);
    expect(() => normalizeConnectHost("http://docker-vm.test")).toThrow(
      /without a scheme/,
    );
  });

  it("renders the engine bind address into machine compatibility", () => {
    const projectRoot = temporaryDirectory("worktrellis-compose-bind");
    fs.writeFileSync(
      path.join(projectRoot, "compose.yml"),
      "services:\n  database:\n    image: postgres:16-alpine\n",
    );
    const spec = {
      name: "infrastructure",
      scope: "machine" as const,
      files: ["compose.yml"],
      ports: {
        database: { service: "database", containerPort: 5432 },
      },
    };
    const loopback = renderStack({
      spec,
      projectRoot,
      identity: identity(),
    });
    const explicitLoopback = renderStack({
      spec,
      projectRoot,
      identity: identity(),
      bindAddress: "127.0.0.1",
    });
    const remote = renderStack({
      spec,
      projectRoot,
      identity: identity(),
      bindAddress: "0.0.0.0",
    });

    expect(loopback.definitionHash).toBe(
      "ece3d74f0d0e6909aa60320730dbcd6f9eda50b3bf07a3a35cc5a6ed9149e2d6",
    );
    expect(loopback.stackId).toBe(
      "worktrellis-machine-infrastructure-ece3d74f",
    );
    expect(explicitLoopback.stackId).toBe(loopback.stackId);
    expect(remote.stackId).not.toBe(loopback.stackId);
    expect(remote.files.at(-1)?.contents).toContain(
      `0.0.0.0:${remote.ports.database}:5432/tcp`,
    );
  });

  it("checks published-port conflicts on the configured interface", () => {
    expect(
      publicationConflicts(
        "127.0.0.1:5432->5432/tcp",
        5432,
        "10.211.55.4",
      ),
    ).toBe(false);
    expect(
      publicationConflicts(
        "10.211.55.4:5432->5432/tcp",
        5432,
        "10.211.55.4",
      ),
    ).toBe(true);
    expect(
      publicationConflicts(
        "0.0.0.0:5432->5432/tcp",
        5432,
        "10.211.55.4",
      ),
    ).toBe(true);
    expect(
      publicationConflicts("[::]:5432->5432/tcp", 5432, "2001:db8::1"),
    ).toBe(true);
    expect(
      publicationConflicts(
        "10.211.55.4:5432->5432/udp",
        5432,
        "10.211.55.4",
        "tcp",
      ),
    ).toBe(false);
  });

  it("brackets IPv6 hosts in HTTP health probes", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));

    await expect(
      probePort({ kind: "http", path: "/health" }, 8080, "2001:db8::1"),
    ).resolves.toEqual({ reachable: true, detail: undefined });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://[2001:db8::1]:8080/health",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("warns when a service endpoint publishes on every host interface", () => {
    const check = endpointDoctorCheck({
      contextName: "parallels-windows",
      endpointFingerprint: "fingerprint",
      bindAddress: "0.0.0.0",
      connectHost: "10.211.55.4",
      isRemote: true,
      configured: true,
      stale: false,
    });

    expect(check).toMatchObject({
      severity: "warn",
      ok: false,
      label: expect.stringContaining("wildcard address 0.0.0.0"),
      fix: expect.stringContaining("specific host interface"),
    });
  });

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
        configVersion: 3,
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
  it("uses the configured Compose host for every protocol endpoint", () => {
    const compose: ComposeContext = {
      host: "10.211.55.4",
      stacks: {
        standard: {
          name: "standard",
          scope: "machine",
          compatibilityId: "worktrellis-machine-standard",
          projectName: "worktrellis-machine-standard",
          ports: { postgres: 5432, redis: 6379, minio: 9000 },
        },
      },
      url: (_stack, _port, scheme = "http") =>
        `${scheme}://10.211.55.4:9000`,
    };
    const resources = resolveResources({
      identity: identity(),
      compose,
      adapters: {
        database: postgresDatabase({
          endpoint: { stack: "standard", port: "postgres" },
          isolation: "database",
          user: "postgres",
          password: "postgres",
        }),
        cache: redisNamespace({
          endpoint: { stack: "standard", port: "redis" },
          isolation: "namespace",
        }),
        storage: s3Bucket({
          endpoint: { stack: "standard", port: "minio" },
          isolation: "bucket",
          accessKey: "minioadmin",
          secretKey: "minioadmin",
        }),
      },
    });

    expect(resources.database.host).toBe("10.211.55.4");
    expect(resources.database.url).toContain("@10.211.55.4:5432/");
    expect(resources.cache.url).toMatch(/^redis:\/\/10\.211\.55\.4:6379\//);
    expect(resources.storage.endpoint).toBe("http://10.211.55.4:9000");
  });

  it("resolves database, Redis namespace, and bucket from one workspace", () => {
    const compose: ComposeContext = {
      host: "127.0.0.1",
      stacks: {
        standard: {
          name: "standard",
          scope: "machine",
          compatibilityId: "worktrellis-machine-standard",
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
          user: "postgres",
          password: "postgres",
        }),
        cache: redisNamespace({
          endpoint: { stack: "standard", port: "redis" },
          isolation: "namespace",
        }),
        storage: s3Bucket({
          endpoint: { stack: "standard", port: "minio" },
          isolation: "bucket",
          accessKey: "minioadmin",
          secretKey: "minioadmin",
        }),
      },
    });

    expect(resources.database.database).toBe("test_feature_test_deadbeef");
    expect(resources.cache.prefix).toBe("{test:feature-test-deadbeef}");
    expect(resources.storage.bucket).toBe("test-feature-test-deadbeef");
  });

  it("rejects missing project-owned resource credentials", () => {
    const compose: ComposeContext = {
      host: "127.0.0.1",
      stacks: {
        standard: {
          name: "standard",
          scope: "machine",
          compatibilityId: "worktrellis-machine-standard",
          projectName: "worktrellis-machine-standard",
          ports: { postgres: 5432, minio: 9000 },
        },
      },
      url: () => "",
    };

    expect(() =>
      resolveResources({
        identity: identity(),
        compose,
        adapters: {
          database: postgresDatabase({
            endpoint: { stack: "standard", port: "postgres" },
            isolation: "database",
            user: "postgres",
            password: () => undefined,
          }),
        },
      }),
    ).toThrow(/postgresDatabase\(\)\.password must resolve/);

    expect(() =>
      resolveResources({
        identity: identity(),
        compose,
        adapters: {
          storage: s3Bucket({
            endpoint: { stack: "standard", port: "minio" },
            isolation: "bucket",
            accessKey: "minioadmin",
            secretKey: () => "",
          }),
        },
      }),
    ).toThrow(/s3Bucket\(\)\.secretKey must resolve/);
  });

  it("keeps custom adapter names and resolved values intact", () => {
    const compose: ComposeContext = {
      host: "127.0.0.1",
      stacks: {
        search: {
          name: "search",
          scope: "workspace",
          compatibilityId: "worktrellis-test-search",
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

  it("parses Docker context endpoint addresses", () => {
    const parsed = parseArgs([
      "services",
      "endpoint",
      "set",
      "--bind-address",
      "0.0.0.0",
      "--connect-host",
      "10.211.55.4",
    ]);
    expect(parsed.subcommand).toBe("endpoint");
    expect(parsed.positionals[1]).toBe("set");
    expect(parsed.flags.get("bind-address")).toBe("0.0.0.0");
    expect(parsed.flags.get("connect-host")).toBe("10.211.55.4");
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
      configVersion: 3,
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
      configVersion: 3,
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

  it("fails an explicit Tailscale request instead of falling back to localhost", async () => {
    const config: WorkTrellisConfig = {
      configVersion: 3,
      project: "test",
      compose: [],
      processes: [],
      env: () => ({}),
      url: { provider: "auto" },
    };

    await expect(
      resolveUrl({
        identity: identity(),
        projectRoot: temporaryDirectory("worktrellis-missing-portless"),
        config,
        tailscale: true,
      }),
    ).rejects.toThrow(/Cannot enable private tailnet sharing/);
  });
});

describe("WorkTrellis runtime status", () => {
  it("distinguishes live supervisors, orphaned children, and stopped runs", () => {
    expect(
      classifyRuntimeState({
        supervisorAlive: true,
        liveChildCount: 0,
        portListening: false,
      }),
    ).toBe("running");
    expect(
      classifyRuntimeState({
        supervisorAlive: false,
        liveChildCount: 1,
        portListening: false,
      }),
    ).toBe("orphaned");
    expect(
      classifyRuntimeState({
        supervisorAlive: false,
        liveChildCount: 0,
        portListening: true,
      }),
    ).toBe("orphaned");
    expect(
      classifyRuntimeState({
        supervisorAlive: false,
        liveChildCount: 0,
        portListening: false,
      }),
    ).toBe("stopped");
  });
});

describe("WorkTrellis Portless process delegation", () => {
  it("captures the exact dynamic private URL returned by Portless", () => {
    expect(
      parsePortlessSharingUrl(
        "\u001b[32m  Tailscale -> https://node.example.ts.net:8443\u001b[39m",
      ),
    ).toBe("https://node.example.ts.net:8443");
    expect(parsePortlessSharingUrl("  -> https://app.localhost")).toBeNull();
    expect(parsePortlessSharingUrl("Tailscale -> not-a-url")).toBeNull();
    expect(
      parsePortlessSharingUrl(
        "Tailscale -> https://user:secret@node.example.ts.net:8443",
      ),
    ).toBeNull();
  });

  it("allows Portless's bounded Tailscale cleanup to finish", () => {
    expect(PORTLESS_TAILSCALE_CLEANUP_GRACE_MS).toBeGreaterThan(30_000);
  });

  it("requires the Portless WebSocket fix for private sharing", () => {
    expect(supportsReliablePortlessTailscale("0.15.4")).toBe(false);
    expect(supportsReliablePortlessTailscale("0.15.5-beta.1")).toBe(false);
    expect(supportsReliablePortlessTailscale("0.15.5")).toBe(true);
    expect(supportsReliablePortlessTailscale("0.16.0-beta.1")).toBe(true);
    expect(supportsReliablePortlessTailscale("1.0.0")).toBe(true);
    expect(supportsReliablePortlessTailscale(undefined)).toBe(false);
  });

  it("requires the app-port process for a private-sharing launch", () => {
    expect(
      includesAppPortProcess([
        {
          name: "worker",
          command: { bin: "pnpm", args: ["worker"] },
        },
      ]),
    ).toBe(false);
    expect(
      includesAppPortProcess([
        {
          name: "app",
          command: { bin: "pnpm", args: ["dev"] },
          bindsAppPort: true,
        },
      ]),
    ).toBe(true);
  });

  it("delegates local routing and the fixed port to Portless", () => {
    expect(
      wrapCommandForPortless(
        { node: ["node_modules/next/dist/bin/next", "dev"] },
        {
          binary: "/project/node_modules/portless/dist/cli.js",
          aliasName: "feature-test-deadbeef.test",
          listenPort: 3210,
          tailscale: false,
        },
        "/project",
      ),
    ).toEqual({
      node: [
        "/project/node_modules/portless/dist/cli.js",
        "--name",
        "feature-test-deadbeef.test",
        "--app-port",
        "3210",
        "--",
        path.basename(process.execPath),
        path.resolve("/project", "node_modules/next/dist/bin/next"),
        "dev",
      ],
    });
  });

  it("quotes space-sensitive child tokens for Portless's Windows cmd wrapper", () => {
    const projectRoot = path.resolve("/Users/Example Person/project");

    expect(quoteWindowsCmdToken("C:\\Program Files\\nodejs\\node.exe")).toBe(
      '"C:\\Program Files\\nodejs\\node.exe"',
    );
    expect(
      wrapCommandForPortless(
        { node: ["node_modules/next/dist/bin/next", "dev"] },
        {
          binary: path.join(projectRoot, "node_modules/portless/dist/cli.js"),
          aliasName: "windows.test",
          listenPort: 3202,
          tailscale: false,
          windowsCmdShell: true,
        },
        projectRoot,
      ),
    ).toMatchObject({
      node: [
        path.join(projectRoot, "node_modules/portless/dist/cli.js"),
        "--name",
        "windows.test",
        "--app-port",
        "3202",
        "--",
        path.basename(process.execPath),
        `"${path.join(projectRoot, "node_modules/next/dist/bin/next")}"`,
        "dev",
      ],
    });
  });

  it("adds private sharing without changing local route ownership", () => {
    expect(
      wrapCommandForPortless(
        { bin: "pnpm", args: ["dev"] },
        {
          binary: "/project/node_modules/portless/dist/cli.js",
          aliasName: "feature-test-deadbeef.test",
          listenPort: 3210,
          tailscale: true,
        },
        "/project",
      ),
    ).toEqual({
      node: [
        "/project/node_modules/portless/dist/cli.js",
        "--name",
        "feature-test-deadbeef.test",
        "--tailscale",
        "--app-port",
        "3210",
        "--",
        "pnpm",
        "dev",
      ],
    });
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

  it("loads a workspace-local Tailscale preference", () => {
    const directory = temporaryDirectory("worktrellis-local-tailscale");
    const file = path.join(directory, "local.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        url: { hostname: "stars-local", tailscale: true },
      }),
    );

    expect(loadWorkspaceLocalConfig(file)).toEqual({
      url: { hostname: "stars-local", tailscale: true },
    });
  });

  it("wires the local override into the command context", async () => {
    const directory = temporaryDirectory("worktrellis-local-context");
    execFileSync("git", ["init", "--quiet"], { cwd: directory });
    fs.writeFileSync(
      path.join(directory, "worktrellis.config.mjs"),
      `export default {
        configVersion: 3,
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
