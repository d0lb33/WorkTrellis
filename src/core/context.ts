import path from "node:path";

import type { WorkspaceIdentity } from "../types";
import { loadConfig, type LoadedConfig } from "./config";
import { resolveIdentity } from "./identity";
import { workspacePaths } from "./state";
import { readEnvFile } from "../util/dotenv";
import { ensureDirectory } from "../util/fs";

/**
 * Everything a command needs before it touches infrastructure: the project's
 * config, this worktree's identity, and the secrets file contents.
 *
 * Deliberately side-effect free apart from creating the per-worktree state
 * directory and pinning identity, so read-only commands stay cheap and safe.
 */
export interface CommandContext {
  config: LoadedConfig["config"];
  projectRoot: string;
  configPath: string;
  identity: WorkspaceIdentity;
  paths: ReturnType<typeof workspacePaths>;
  /** Parsed secrets file. Never written. */
  baseEnv: Map<string, string>;
  baseEnvPath: string;
}

export async function buildContext(options: {
  cwd?: string;
  configPath?: string;
}): Promise<CommandContext> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const loaded = await loadConfig({ cwd, configPath: options.configPath });

  const bootstrapPaths = workspacePaths(loaded.projectRoot);
  ensureDirectory(bootstrapPaths.root);

  const identity = await resolveIdentity({
    cwd: loaded.projectRoot,
    project: loaded.config.project,
    pinFile: bootstrapPaths.workspace,
    extraPorts: loaded.config.extraPorts,
    basePort: loaded.config.url?.basePort,
  });

  // Re-derive now that the slug is known, so log paths are unambiguous across
  // worktrees that happen to share a directory name.
  const paths = workspacePaths(
    loaded.projectRoot,
    `${identity.project}-${identity.slug}`,
  );

  const baseEnvPath = path.resolve(
    loaded.projectRoot,
    loaded.config.baseEnvFile ?? ".env",
  );

  return {
    config: loaded.config,
    projectRoot: loaded.projectRoot,
    configPath: loaded.configPath,
    identity,
    paths,
    baseEnv: readEnvFile(baseEnvPath),
    baseEnvPath,
  };
}
