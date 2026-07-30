import type { UrlContext, WorkspaceIdentity } from "../types";
import { findAvailablePort } from "../platform/ports";

/**
 * Plain loopback URLs. Always available: no certificates, no hosts file, no
 * elevation. This is the fallback whenever the richer provider cannot run, and
 * the right default in CI.
 *
 * The port is derived from the worktree path, so it is stable across restarts
 * and a bookmark keeps working. It only moves if something else takes it.
 */
export async function resolveDirectUrl(
  identity: WorkspaceIdentity,
  options: { fallbackReason?: string } = {},
): Promise<UrlContext> {
  const preferred = identity.ports.app ?? 3000;
  const port = await findAvailablePort(preferred, { span: 200 });

  // Browsers resolve *.localhost to loopback themselves, so tenant subdomains
  // work here without touching the hosts file. Cookies are not shared across
  // the localhost suffix, so no cookie domain is set.
  const rootDomain = "localhost";

  return {
    mode: "direct",
    appUrl: `http://${rootDomain}:${port}`,
    rootDomain,
    cookieDomain: "",
    tenantUrlTemplate: `http://<subdomain>.${rootDomain}:${port}`,
    wildcardOrigins: [rootDomain, `*.${rootDomain}`, `*.*.${rootDomain}`],
    listenHost: "127.0.0.1",
    listenPort: port,
    providerEnv: {},
    fallbackReason: options.fallbackReason,
  };
}
