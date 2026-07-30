import fs from "node:fs";
import path from "node:path";

import { WorkTrellisError } from "../core/errors";
import { homePaths } from "../core/state";
import { atomicWrite, ensureDirectory } from "../util/fs";
import { run } from "../util/proc";
import type { ContainerEngine } from "./engine";
import type { RenderedStack } from "./compose-render";

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
  readonly composeFile: string;

  constructor(engine: ContainerEngine, rendered: RenderedStack) {
    this.engine = engine;
    this.rendered = rendered;
    this.directory = homePaths.stack(rendered.stackId);
    this.composeFile = path.join(this.directory, "compose.yaml");
  }

  /** Whether the on-disk stack is exactly the definition represented here. */
  matchesDefinition(): boolean {
    const hashFile = path.join(this.directory, "spec.sha256");
    if (!fs.existsSync(hashFile) || !fs.existsSync(this.composeFile)) return false;

    try {
      return (
        fs.readFileSync(hashFile, "utf8").trim() === this.rendered.specHash &&
        fs.readFileSync(this.composeFile, "utf8") === this.rendered.yaml
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

    atomicWrite(this.composeFile, this.rendered.yaml, { mode: 0o644 });
    atomicWrite(hashFile, `${this.rendered.specHash}\n`, { mode: 0o644 });
    return true;
  }

  private args(rest: string[]): string[] {
    return [
      ...this.engine.compose.slice(1),
      "-p",
      this.rendered.stackId,
      "-f",
      this.composeFile,
      ...rest,
    ];
  }

  private exec(rest: string[], options: { quiet?: boolean; timeoutMs?: number } = {}) {
    const cli = this.engine.compose[0];
    if (!cli) throw new WorkTrellisError("Compose command is not configured.");
    return run(cli, this.args(rest), {
      cwd: this.directory,
      quiet: options.quiet,
      timeoutMs: options.timeoutMs,
    });
  }

  async up(timeoutSeconds = 120): Promise<void> {
    const waited = await this.exec(
      ["up", "-d", "--wait", "--wait-timeout", String(timeoutSeconds)],
      { quiet: true, timeoutMs: (timeoutSeconds + 30) * 1000 },
    );
    if (waited.code === 0) return;

    // Older Compose builds have no --wait; fall back and let the caller's own
    // readiness probes decide when the service is usable.
    const plain = await this.exec(["up", "-d"], {
      quiet: true,
      timeoutMs: (timeoutSeconds + 30) * 1000,
    });

    if (plain.code !== 0) {
      throw new WorkTrellisError(
        `Failed to start ${this.rendered.stackId}.`,
        {
          remediation: [waited.stderr, plain.stderr]
            .map((text) => text.trim())
            .filter(Boolean)
            .join("\n")
            .split("\n")
            .slice(-6)
            .join("\n"),
        },
      );
    }
  }

  async down(options: { volumes?: boolean } = {}): Promise<void> {
    const rest = ["down"];
    if (options.volumes) rest.push("--volumes");

    const result = await this.exec(rest, { quiet: true, timeoutMs: 120_000 });
    if (result.code !== 0) {
      throw new WorkTrellisError(
        `Failed to stop ${this.rendered.stackId}.`,
        { remediation: result.stderr.trim().split("\n").slice(-4).join("\n") },
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
