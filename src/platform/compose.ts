import fs from "node:fs";
import path from "node:path";

import { WorkTrellisError } from "../core/errors";
import { homePaths } from "../core/state";
import { atomicWrite, ensureDirectory } from "../util/fs";
import { run } from "../util/proc";
import type { ContainerEngine } from "./engine";
import type { RenderedStack } from "./compose-render";
import { redactDiagnosticText } from "../core/env-resolve";

export interface ComposePublisher {
  URL?: string;
  TargetPort?: number;
  PublishedPort?: number;
  Protocol?: string;
}

export interface ComposePsEntry {
  Name?: string;
  Service?: string;
  State?: string;
  Health?: string;
  Status?: string;
  Publishers?: ComposePublisher[];
}

/** Compose emits NDJSON in some versions and a JSON array in others. */
export function parseComposeJson(stdout: string): ComposePsEntry[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed) as ComposePsEntry[];
    } catch {
      return [];
    }
  }

  const entries: ComposePsEntry[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    try {
      entries.push(JSON.parse(line) as ComposePsEntry);
    } catch {
      // A malformed line should not fail the whole command.
    }
  }
  return entries;
}

/**
 * A single generated compose stack living under the WorkTrellis home directory,
 * shared by every project and worktree that needs this service.
 */
export class ComposeStack {
  readonly engine: ContainerEngine;
  readonly rendered: RenderedStack;
  readonly directory: string;
  readonly composeFiles: string[];

  constructor(engine: ContainerEngine, rendered: RenderedStack) {
    this.engine = engine;
    this.rendered = rendered;
    this.directory = homePaths.stack(rendered.stackId);
    this.composeFiles = rendered.files.map((file) =>
      path.join(this.directory, file.name),
    );
  }

  /** Whether the on-disk stack is exactly the definition represented here. */
  matchesDefinition(): boolean {
    const hashFile = path.join(this.directory, "spec.sha256");
    if (
      !fs.existsSync(hashFile) ||
      this.composeFiles.some((file) => !fs.existsSync(file))
    ) {
      return false;
    }

    try {
      return (
        fs.readFileSync(hashFile, "utf8").trim() === this.rendered.specHash &&
        this.rendered.files.every(
          (file, index) =>
            fs.readFileSync(this.composeFiles[index]!, "utf8") === file.contents,
        )
      );
    } catch {
      return false;
    }
  }

  /** Write the compose file if the spec changed. Returns true when rewritten. */
  sync(): boolean {
    ensureDirectory(this.directory);

    const hashFile = path.join(this.directory, "spec.sha256");
    if (this.matchesDefinition()) return false;

    for (const [index, file] of this.rendered.files.entries()) {
      atomicWrite(this.composeFiles[index]!, file.contents, { mode: 0o644 });
    }
    atomicWrite(
      path.join(this.directory, "files.json"),
      `${JSON.stringify(this.rendered.files.map((file) => file.name), null, 2)}\n`,
      { mode: 0o644 },
    );
    atomicWrite(hashFile, `${this.rendered.specHash}\n`, { mode: 0o644 });
    return true;
  }

  private args(
    rest: string[],
    composeFiles = this.composeFiles,
  ): string[] {
    return [
      ...this.engine.compose.slice(1),
      "-p",
      this.rendered.stackId,
      "--project-directory",
      this.rendered.projectDirectory,
      ...composeFiles.flatMap((file) => ["-f", file]),
      ...rest,
    ];
  }

  private exec(
    rest: string[],
    options: {
      quiet?: boolean;
      timeoutMs?: number;
      composeFiles?: string[];
    } = {},
  ) {
    const cli = this.engine.compose[0];
    if (!cli) throw new WorkTrellisError("Compose command is not configured.");
    return run(cli, this.args(rest, options.composeFiles), {
      cwd: this.directory,
      env: { ...process.env, ...this.rendered.environment },
      quiet: options.quiet,
      timeoutMs: options.timeoutMs,
    });
  }

  async up(timeoutSeconds = 120): Promise<void> {
    await this.validateProjectDefinitions();
    const waited = await this.exec(
      [
        "up",
        "-d",
        "--remove-orphans",
        "--wait",
        "--wait-timeout",
        String(timeoutSeconds),
      ],
      { quiet: true, timeoutMs: (timeoutSeconds + 30) * 1000 },
    );
    if (waited.code === 0) return;

    // Older Compose builds have no --wait; fall back and let the caller's own
    // readiness probes decide when the service is usable.
    const plain = await this.exec(["up", "-d", "--remove-orphans"], {
      quiet: true,
      timeoutMs: (timeoutSeconds + 30) * 1000,
    });

    if (plain.code !== 0) {
      throw new WorkTrellisError(
        `Failed to start ${this.rendered.stackId}.`,
        {
          remediation: redactDiagnosticText(
            [waited.stderr, plain.stderr]
              .map((text) => text.trim())
              .filter(Boolean)
              .join("\n")
              .split("\n")
              .slice(-6)
              .join("\n"),
            this.rendered.environment,
          ),
        },
      );
    }
  }

  /**
   * WorkTrellis is the only host-port publisher. Ask Compose to merge and
   * interpolate the project files, then reject pre-existing publications
   * before applying the generated final override.
   */
  private async validateProjectDefinitions(): Promise<void> {
    const projectFiles = this.composeFiles.slice(0, -1);
    const result = await this.exec(["config", "--format", "json"], {
      quiet: true,
      timeoutMs: 60_000,
      composeFiles: projectFiles,
    });
    if (result.code !== 0) {
      throw new WorkTrellisError(
        `Project Compose definition for ${this.rendered.name} is invalid.`,
        {
          remediation: redactDiagnosticText(
            result.stderr
              .trim()
              .split("\n")
              .slice(-8)
              .join("\n"),
            this.rendered.environment,
          ),
        },
      );
    }

    let model: {
      services?: Record<string, { ports?: unknown[] }>;
    };
    try {
      model = JSON.parse(result.stdout) as typeof model;
    } catch {
      throw new WorkTrellisError(
        `Compose did not return a valid merged model for ${this.rendered.name}.`,
      );
    }

    const publishers = Object.entries(model.services ?? {})
      .filter(([, service]) => (service.ports?.length ?? 0) > 0)
      .map(([service]) => service);
    if (publishers.length > 0) {
      throw new WorkTrellisError(
        `Project Compose files publish host ports for ${publishers.join(", ")}.`,
        {
          remediation:
            "Remove `ports` from those services and declare named ports in worktrellis.config.ts. WorkTrellis publishes them on loopback.",
        },
      );
    }

    const missing = [
      ...new Set(
        Object.values(this.rendered.portSpecs)
          .map((port) => port.service)
          .filter((service) => !model.services?.[service]),
      ),
    ];
    if (missing.length > 0) {
      throw new WorkTrellisError(
        `Named ports in stack "${this.rendered.name}" reference missing Compose service(s): ${missing.join(", ")}.`,
        {
          remediation:
            "Fix each `ports.*.service` value so it matches a service in the merged project Compose files.",
        },
      );
    }
  }

  async down(options: { volumes?: boolean } = {}): Promise<void> {
    const rest = ["down", "--remove-orphans"];
    if (options.volumes) rest.push("--volumes");

    const result = await this.exec(rest, { quiet: true, timeoutMs: 120_000 });
    if (result.code !== 0) {
      throw new WorkTrellisError(
        `Failed to stop ${this.rendered.stackId}.`,
        {
          remediation: redactDiagnosticText(
            result.stderr.trim().split("\n").slice(-4).join("\n"),
            this.rendered.environment,
          ),
        },
      );
    }
  }

  async ps(): Promise<ComposePsEntry[]> {
    const result = await this.exec(["ps", "--format", "json", "--all"], {
      quiet: true,
      timeoutMs: 60_000,
    });
    if (result.code !== 0) return [];
    return parseComposeJson(result.stdout);
  }

  async logs(options: { tail?: number; follow?: boolean } = {}): Promise<number> {
    const rest = ["logs", "--tail", String(options.tail ?? 100)];
    if (options.follow) rest.push("--follow");
    const result = await this.exec(rest);
    return result.code;
  }

  /** True when every container in the stack is running and not unhealthy. */
  async isHealthy(): Promise<boolean> {
    const entries = await this.ps();
    if (entries.length === 0) return false;
    return entries.every(
      (entry) =>
        entry.State === "running" &&
        (entry.Health === undefined ||
          entry.Health === "" ||
          entry.Health === "healthy"),
    );
  }
}
