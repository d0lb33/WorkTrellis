import type { UrlContext, WorkspaceIdentity, WorkTrellisConfig } from "../types";
import { WorkTrellisError } from "../core/errors";
import { resolveDirectUrl } from "./direct";
import {
  previewPortlessUrl,
  resolvePortlessUrl,
  type PortlessAppRunner,
} from "./portless";

export interface ResolvedUrl {
  url: UrlContext;
  /** Portless wrapper for every Portless-backed app process. */
  portlessAppRunner?: PortlessAppRunner;
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
  /** Workspace-local exact Portless alias below `.localhost`. */
  hostname?: string;
  /** Ask Portless to share the app privately through Tailscale. */
  tailscale?: boolean;
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
          : previewPortlessUrl(options.identity, listenPort, options.hostname),
      release: async () => {},
    };
  }

  if (preference === "direct") {
    if (options.tailscale) {
      throw new WorkTrellisError(
        "Private tailnet sharing requires the Portless URL provider.",
        {
          remediation:
            "Remove --direct, or disable Tailscale sharing for this run.",
        },
      );
    }
    return { url: await resolveDirectUrl(options.identity), release: async () => {} };
  }

  const attempt = await resolvePortlessUrl(options.identity, {
    projectRoot: options.projectRoot,
    hostname: options.hostname,
    tailscale: options.tailscale,
    wildcard: options.config.url?.wildcard ?? false,
  });

  if ("failed" in attempt) {
    if (preference === "portless" || options.tailscale) {
      throw new WorkTrellisError(
        options.tailscale
          ? `Cannot enable private tailnet sharing: ${attempt.reason}.`
          : `Cannot use portless: ${attempt.reason}.`,
        {
          remediation:
            options.tailscale
              ? "Install and configure Portless under Node 24 or newer, or disable Tailscale sharing for this run."
              : "Fix the problem above, or run with --direct to use a plain localhost port instead.",
        },
      );
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
    portlessAppRunner: attempt.appRunner,
    release: attempt.release,
  };
}
