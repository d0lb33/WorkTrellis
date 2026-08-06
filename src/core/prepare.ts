import type { EnvContext } from "../types";
import { buildContext, type CommandContext } from "./context";
import { buildEnvContext, resolveEnv, writeSnapshot, type ResolvedEnv } from "./env-resolve";
import { readLiveRunState, touchWorkspaceRecord } from "./state";
import { isProcessAlive } from "../util/proc";
import type { UrlContext } from "../types";
import {
  ensureInfrastructure,
  type EnsureResult,
} from "../platform/stack";
import { resolveResources } from "../resources";
import { resolveUrl, type ResolvedUrl, type UrlPreference } from "../url/provider";

/**
 * The shared prelude for every command that needs a fully resolved environment:
 * identity, scoped Compose infrastructure, a URL, and the merged env.
 *
 * `startServices` distinguishes the commands that may change machine state
 * (`up`) from those that must only observe it (`env`, `doctor`, `status`).
 */
export interface PreparedWorkspace {
  context: CommandContext;
  infrastructure: EnsureResult;
  url: ResolvedUrl;
  envContext: EnvContext;
  env: ResolvedEnv;
}

export async function prepareWorkspace(options: {
  cwd?: string;
  configPath?: string;
  startServices?: boolean;
  urlPreference?: UrlPreference;
  tailscale?: boolean;
  /**
   * Report the URL without contacting or mutating its provider. Read-only
   * commands MUST set this.
   */
  peekUrl?: boolean;
  writeSnapshotFile?: boolean;
  allowNewMachineVariants?: readonly string[];
  /** Diagnostics may inspect a stale endpoint mapping without using it. */
  allowStaleEndpoint?: boolean;
}): Promise<PreparedWorkspace> {
  const context = await buildContext(options);

  const infrastructure = await ensureInfrastructure(context.config.compose, {
    identity: context.identity,
    projectRoot: context.projectRoot,
    baseEnv: Object.freeze(Object.fromEntries(context.baseEnv)),
    startIfStopped: options.startServices ?? false,
    allowNewMachineVariants: options.allowNewMachineVariants,
    allowStaleEndpoint: options.allowStaleEndpoint,
  });

  // Reuse what a live run already registered, when there is one.
  const live = options.peekUrl ? readLiveRunState(context.paths.state) : null;
  const liveUrl =
    live && isProcessAlive(live.pid) ? (live.url as UrlContext) : null;

  const url = await resolveUrl({
    identity: context.identity,
    projectRoot: context.projectRoot,
    config: context.config,
    preference: options.urlPreference,
    hostname: context.localConfig.url?.hostname,
    tailscale:
      options.tailscale ?? context.localConfig.url?.tailscale ?? false,
    peek: options.peekUrl,
    live: liveUrl,
  });

  const resources = resolveResources({
    adapters: context.config.resources,
    compose: infrastructure.compose,
    identity: context.identity,
    baseEnv: Object.freeze(Object.fromEntries(context.baseEnv)),
  });

  const envContext = buildEnvContext({
    identity: context.identity,
    compose: infrastructure.compose,
    resources,
    url: url.url,
    baseEnv: context.baseEnv,
  });

  const env = resolveEnv(context.config, envContext, context.baseEnv);

  if (options.writeSnapshotFile !== false) {
    writeSnapshot(context.paths.env, env.owned, context.identity);
    touchWorkspaceRecord(context.identity, {
      hostname: url.url.rootDomain,
      appUrl: url.url.appUrl,
      composeProjects: infrastructure.stacks.map(({ stack }) => ({
        name: stack.rendered.name,
        compatibilityId: stack.rendered.compatibilityId,
        projectName: stack.rendered.stackId,
      })),
    });
  }

  return { context, infrastructure, url, envContext, env };
}
