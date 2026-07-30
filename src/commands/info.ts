import path from "node:path";

import { buildContext } from "../core/context";
import { EXIT } from "../core/errors";
import { readWorkspaceRecords } from "../core/state";
import { c, heading, info, table } from "../util/log";

export interface InfoOptions {
  cwd?: string;
  configPath?: string;
  json?: boolean;
}

export async function runInfo(options: InfoOptions): Promise<number> {
  const context = await buildContext(options);
  const { identity } = context;

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          ...identity,
          configPath: context.configPath,
          projectRoot: context.projectRoot,
          baseEnvFile: context.baseEnvPath,
          stateDirectory: context.paths.root,
        },
        null,
        2,
      ),
    );
    return EXIT.ok;
  }

  heading(`${identity.project}  ${c.cyan(identity.slug)}`);
  info("");

  table([
    ["worktree", identity.root],
    [
      "branch",
      identity.branch ?? c.yellow("detached HEAD"),
    ],
    ["head", identity.head],
    [
      "kind",
      identity.isLinkedWorktree ? "linked worktree" : "main checkout",
    ],
    ["fingerprint", identity.fingerprint],
    ["repo key", identity.repoKey],
  ]);

  info("");
  heading("  Process ports");
  table([
    ...Object.entries(identity.ports).map(
      ([name, port]) => [name, String(port)] as [string, string],
    ),
  ]);

  info("");
  heading("  Configuration");
  table([
    ["config", path.relative(context.projectRoot, context.configPath)],
    [
      "secrets",
      `${path.relative(context.projectRoot, context.baseEnvPath)} (${context.baseEnv.size} keys, read-only)`,
    ],
    ["state", path.relative(context.projectRoot, context.paths.root)],
  ]);

  const siblings = readWorkspaceRecords({ project: identity.project }).filter(
    (record) => record.slug !== identity.slug,
  );
  if (siblings.length > 0) {
    info("");
    info(
      c.gray(
        `  ${siblings.length} other ${identity.project} workspace(s) known to this machine — see \`worktrellis list\`.`,
      ),
    );
  }

  return EXIT.ok;
}
