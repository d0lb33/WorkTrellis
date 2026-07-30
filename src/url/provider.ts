import type { UrlContext, WorkspaceIdentity, WorkTrellisConfig } from "../types";
import { WorkTrellisError } from "../core/errors";
import { resolveDirectUrl } from "./direct";
import {
  previewPortlessUrl,
  releasePortlessAlias,
  resolvePortlessUrl,
} from "./portless";

export interface ResolvedUrl {
  url: UrlContext;
  /** Called on shutdown to release any registration the provider made. */
  release: () => Promise<void>;
}

export type UrlPreference = "portless" | "direct" | "auto";

/**
 * Choose a URL provider.
 *
 * "auto" prefers the richer provider and silently degrades to plain loopback
 * when it cannot run, reporting the reason once so the developer knows what to
 * install if they want the better experience. An explicit preference is honored
 * strictly: asking for portless and not getting it is an error, not a surprise.
 */
export async function resolveUrl(options: {
  identity: WorkspaceIdentity;
  projectRoot: string;
  config: WorkTrellisConfig;
  preference?: UrlPreference;
  /**
   * Report the URL without claiming it: no port is bound and no route is
   * registered. Read-only commands must use this — re-registering a hostname
   * while the app is running would repoint it at a dead port.
   */
  peek?: boolean;
  /** A URL recorded by a live run, preferred over any derived guess. */
  live?: UrlContext | null;
}): Promise<ResolvedUrl> {
  const preference =
    options.preference ?? options.config.url?.provider ?? "auto";

  if (options.peek) {
    if (options.live) {
      return { url: options.live, release: async () => {} };
    }

    const listenPort = options.identity.ports.app ?? 3000;
    return {
      url:
        preference === "direct"
          ? {
              mode: "direct",
              appUrl: `http://localhost:${listenPort}`,
              rootDomain: "localhost",
              cookieDomain: "",
              tenantUrlTemplate: `http://<subdomain>.localhost:${listenPort}`,
              wildcardOrigins: ["localhost", "*.localhost", "*.*.localhost"],
              listenHost: "127.0.0.1",
              listenPort,
              providerEnv: {},
            }
          : previewPortlessUrl(options.identity, listenPort),
      release: async () => {},
    };
  }

  if (preference === "direct") {
    return { url: await resolveDirectUrl(options.identity), release: async () => {} };
  }

  const attempt = await resolvePortlessUrl(options.identity, {
    projectRoot: options.projectRoot,
  });

  if ("failed" in attempt) {
    if (preference === "portless") {
      throw new WorkTrellisError(`Cannot use portless: ${attempt.reason}.`, {
        remediation:
          "Fix the problem above, or run with --direct to use a plain localhost port instead.",
      });
    }

    return {
      url: await resolveDirectUrl(options.identity, {
        fallbackReason: attempt.reason,
      }),
      release: async () => {},
    };
  }

  return {
    url: attempt.url,
    release: () => releasePortlessAlias(options.projectRoot, attempt.aliasName),
  };
}
