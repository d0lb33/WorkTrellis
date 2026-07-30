import fs from "node:fs";
import path from "node:path";

import type { DoctorResult } from "../types";
import { EXIT } from "../core/errors";
import { prepareWorkspace } from "../core/prepare";
import { readMachineConfig } from "../core/state";
import { engineContext, engineVersion } from "../platform/engine";
import { c, heading, info } from "../util/log";

export interface DoctorOptions {
  cwd?: string;
  configPath?: string;
  json?: boolean;
}

/** Like DoctorResult, but with "ok" added so passing checks share one shape. */
type Check = Omit<DoctorResult, "severity"> & {
  severity: "ok" | "warn" | "fail";
};

function ok(label: string, detail?: string): Check {
  return { ok: true, label, detail, severity: "ok" };
}

function warn(label: string, detail?: string, fix?: string): Check {
  return { ok: false, label, detail, fix, severity: "warn" };
}

function fail(label: string, detail?: string, fix?: string): Check {
  return { ok: false, label, detail, fix, severity: "fail" };
}

export async function runDoctor(options: DoctorOptions): Promise<number> {
  const checks: Check[] = [];

  const [major] = process.versions.node.split(".");
  checks.push(
    Number(major) >= 22
      ? ok(`node ${process.versions.node}`)
      : fail(
          `node ${process.versions.node}`,
          "WorkTrellis needs Node 22 or newer.",
          "Install a current Node release.",
        ),
  );

  const prepared = await prepareWorkspace({
    cwd: options.cwd,
    configPath: options.configPath,
    startServices: false,
    // Report the URL; never claim it. Diagnostics must not disturb a running app.
    peekUrl: true,
    writeSnapshotFile: false,
  });

  const { context, services, env } = prepared;

  checks.push(
    ok(
      `${services.engine.name} ${await engineVersion(services.engine)}`,
      (await engineContext(services.engine))?.endpoint,
    ),
  );

  // Services
  for (const status of services.statuses) {
    const ports = Object.values(status.ports).join(", ");
    if (!status.running) {
      checks.push(
        warn(`${status.kind} is not running`, `ports ${ports}`, "pnpm services:up"),
      );
    } else if (!status.reachable) {
      checks.push(
        fail(
          `${status.kind} is running but not reachable from this machine`,
          `${status.detail ?? ""}${services.remoteEngineNote ? ` — ${services.remoteEngineNote}` : ""}`,
          "Check the port forwarding between this machine and the container engine host.",
        ),
      );
    } else {
      checks.push(ok(`${status.kind} ready`, `ports ${ports}`));
    }
  }

  // Env conflicts: the reason a worktree might not be as isolated as it looks.
  const critical = env.conflicts.filter((conflict) => conflict.severity === "critical");
  const informational = env.conflicts.filter((conflict) => conflict.severity === "info");

  if (critical.length > 0) {
    checks.push(
      fail(
        `${critical.length} critical key(s) in ${path.basename(context.baseEnvPath)} shadow WorkTrellis-managed values`,
        critical.map((conflict) => conflict.key).join(", "),
        `Delete those lines from ${path.basename(context.baseEnvPath)}; WorkTrellis supplies them per worktree.`,
      ),
    );
  } else {
    checks.push(ok(`${path.basename(context.baseEnvPath)} has no conflicting keys`));
  }

  if (informational.length > 0) {
    checks.push(
      warn(
        `${informational.length} non-critical key(s) also set in ${path.basename(context.baseEnvPath)}`,
        informational.map((conflict) => conflict.key).join(", "),
      ),
    );
  }

  // Package scripts must read the snapshot, or they silently bypass isolation.
  const manifestPath = path.join(context.projectRoot, "package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    scripts?: Record<string, string>;
  };
  const stale = Object.entries(manifest.scripts ?? {}).filter(([, value]) =>
    /--env-file=/.test(value),
  );
  checks.push(
    stale.length === 0
      ? ok("package scripts read the generated snapshot")
      : warn(
          `${stale.length} package script(s) still use a hardcoded --env-file`,
          stale.map(([name]) => name).join(", "),
          "Switch them to --env-file-if-exists for the secrets file and the snapshot.",
        ),
  );

  // Leftovers from tooling WorkTrellis replaced.
  const legacyProjectFile = path.join(context.projectRoot, ".docker-project-name");
  if (fs.existsSync(legacyProjectFile)) {
    const name = fs.readFileSync(legacyProjectFile, "utf8").trim();
    checks.push(
      warn(
        "a container stack from the previous tooling is still recorded",
        `project "${name}"`,
        `It may still hold the shared ports. Stop it with:\n  docker compose -p ${name} down\nThen delete ${legacyProjectFile}`,
      ),
    );
  }

  const overrides = readMachineConfig().portOverrides ?? {};
  if (Object.keys(overrides).length > 0) {
    checks.push(
      ok(
        "machine port overrides in effect",
        Object.entries(overrides)
          .map(([kind, port]) => `${kind}=${port}`)
          .join(", "),
      ),
    );
  }

  // Project-supplied checks.
  for (const check of context.config.doctor ?? []) {
    const result = await check(prepared.envContext);
    checks.push({
      ...result,
      severity: result.ok ? "ok" : (result.severity ?? "warn"),
    });
  }

  if (options.json) {
    console.log(JSON.stringify(checks, null, 2));
  } else {
    heading(`worktrellis doctor  ${c.cyan(context.identity.slug)}`);
    info("");
    for (const check of checks) {
      const badge =
        check.severity === "ok"
          ? c.green("ok  ")
          : check.severity === "warn"
            ? c.yellow("warn")
            : c.red("fail");
      info(`  ${badge}  ${check.label}`);
      if (check.detail) info(`        ${c.gray(check.detail)}`);
      // A remediation on a passing check is noise.
      if (check.fix && check.severity !== "ok") {
        for (const line of check.fix.split("\n")) {
          info(`        ${c.cyan("->")} ${line}`);
        }
      }
    }
    info("");
  }

  return checks.some((check) => check.severity === "fail")
    ? EXIT.checkFailed
    : EXIT.ok;
}
