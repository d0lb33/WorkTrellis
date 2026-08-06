import path from "node:path";

import { buildContext, type CommandContext } from "../core/context";
import { EXIT, WorkTrellisError } from "../core/errors";
import { readWorkspaceRecords } from "../core/state";
import { renderStack } from "../platform/compose-render";
import { detectEngine } from "../platform/engine";
import { resolveEngineEndpoint } from "../platform/engine-endpoint";
import { selectedLineage } from "../platform/lineage-state";
import type { ResolvedComposeStack } from "../types";
import { c, heading, info, table } from "../util/log";

export interface InfoOptions {
  cwd?: string;
  configPath?: string;
  json?: boolean;
}

export function resolveInfoComposeProjects(
  context: Pick<
    CommandContext,
    "config" | "projectRoot" | "identity" | "baseEnv"
  >,
  bindAddress = "127.0.0.1",
): ResolvedComposeStack[] {
  const baseEnv = Object.freeze(Object.fromEntries(context.baseEnv));

  return context.config.compose.map((spec) => {
    const rendered = renderStack({
      spec,
      projectRoot: context.projectRoot,
      identity: context.identity,
      baseEnv,
      bindAddress,
    });
    const selection =
      spec.scope === "machine"
        ? selectedLineage(rendered.compatibilityId)
        : null;

    return {
      name: rendered.name,
      scope: rendered.scope,
      compatibilityId: rendered.compatibilityId,
      projectName: selection?.projectName ?? rendered.stackId,
      ports: Object.freeze({ ...(selection?.ports ?? rendered.ports) }),
    };
  });
}

export async function runInfo(options: InfoOptions): Promise<number> {
  const context = await buildContext(options);
  const { identity } = context;
  let bindAddress = "127.0.0.1";
  try {
    bindAddress = (await resolveEngineEndpoint(await detectEngine())).bindAddress;
  } catch (caught) {
    // Identity inspection remains useful before a container engine is
    // installed. A stale configured mapping is different: using loopback would
    // report the wrong compatibility identity, so preserve that failure.
    if (!(caught instanceof WorkTrellisError) || !/No container engine found/.test(caught.message)) {
      throw caught;
    }
  }
  const composeProjects = resolveInfoComposeProjects(context, bindAddress);

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          ...identity,
          configPath: context.configPath,
          projectRoot: context.projectRoot,
          baseEnvFile: context.baseEnvPath,
          stateDirectory: context.paths.root,
          composeProjects,
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
  heading("  Compose projects");
  if (composeProjects.length === 0) {
    info(c.gray("  none"));
  } else {
    table(
      composeProjects.map((stack) => [
        `${stack.name} (${stack.scope})`,
        `${stack.projectName}${
          stack.projectName !== stack.compatibilityId
            ? c.gray(`  desired ${stack.compatibilityId}`)
            : ""
        }`,
      ]),
    );
  }
  info(
    c.gray(
      "  Docker groups service containers under these project names; app processes run on the host.",
    ),
  );

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
