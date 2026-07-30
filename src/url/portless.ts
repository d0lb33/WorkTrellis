import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { UrlContext, WorkspaceIdentity } from "../types";
import { findAvailablePort } from "../platform/ports";
import { run } from "../util/proc";

/**
 * Public HTTPS hostnames with wildcard subdomains, via the `portless` proxy.
 *
 * Deliberately NOT using `portless run`: that path unconditionally prefixes the
 * hostname with a name derived from the branch, which collides whenever two
 * worktrees share a branch's last segment and disappears entirely on the
 * default branch. `portless alias` registers the exact hostname we ask for, and
 * WorkTrellis supervises the app process itself — which it must do anyway, for
 * tree-kill and orphan reaping.
 */

export interface PortlessProbe {
  available: boolean;
  reason?: string;
  binary?: string;
}

function stateDir(): string {
  const override = process.env.PORTLESS_STATE_DIR?.trim();
  return override ? path.resolve(override) : path.join(os.homedir(), ".portless");
}

export function findPortlessBinary(projectRoot: string): string | null {
  const candidate = path.join(
    projectRoot,
    "node_modules",
    "portless",
    "dist",
    "cli.js",
  );
  return fs.existsSync(candidate) ? candidate : null;
}

export function probePortless(projectRoot: string): PortlessProbe {
  if (process.env.PORTLESS === "0") {
    return { available: false, reason: "PORTLESS=0 is set" };
  }

  const binary = findPortlessBinary(projectRoot);
  if (!binary) {
    return {
      available: false,
      reason: "the portless package is not installed in this project",
    };
  }

  const [major] = process.versions.node.split(".");
  if (Number(major) < 24) {
    return {
      available: false,
      reason: `portless requires Node 24 or newer (running ${process.versions.node})`,
    };
  }

  return { available: true, binary };
}

async function portless(
  binary: string,
  args: string[],
  options: { timeoutMs?: number } = {},
) {
  return run(process.execPath, [binary, ...args], {
    quiet: true,
    timeoutMs: options.timeoutMs ?? 60_000,
    env: { ...process.env, PORTLESS_WILDCARD: "1" },
  });
}

/** Start the shared proxy if it is not already running. Idempotent. */
async function ensureProxy(binary: string): Promise<{ ok: boolean; detail?: string }> {
  const result = await portless(binary, ["proxy", "start", "--wildcard"], {
    timeoutMs: 120_000,
  });

  if (result.code === 0) return { ok: true };

  // Already running is a success for our purposes.
  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (output.includes("already running")) return { ok: true };

  return {
    ok: false,
    detail: `${result.stderr || result.stdout}`.trim().split("\n").slice(-3).join(" "),
  };
}

export interface PortlessRegistration {
  url: UrlContext;
  /** Hostname registered with the proxy; must be released on shutdown. */
  aliasName: string;
}

/** The hostname this workspace uses, without contacting the proxy. */
export function portlessAliasName(identity: WorkspaceIdentity): string {
  return `${identity.slug}.${identity.project}`;
}

/**
 * Describe the URL this workspace *would* use, registering nothing.
 *
 * Read-only commands must never touch the route table: re-registering an alias
 * while the app is running would repoint the live hostname at a port nothing is
 * listening on.
 */
export function previewPortlessUrl(
  identity: WorkspaceIdentity,
  listenPort: number,
): UrlContext {
  const rootDomain = `${portlessAliasName(identity)}.localhost`;

  return {
    mode: "portless",
    appUrl: `https://${rootDomain}`,
    rootDomain,
    cookieDomain: `.${rootDomain}`,
    tenantUrlTemplate: `https://<subdomain>.${rootDomain}`,
    wildcardOrigins: [rootDomain, `*.${rootDomain}`, `*.*.${rootDomain}`],
    listenHost: "127.0.0.1",
    listenPort,
    providerEnv: {},
  };
}

export async function resolvePortlessUrl(
  identity: WorkspaceIdentity,
  options: { projectRoot: string },
): Promise<PortlessRegistration | { failed: true; reason: string }> {
  const probe = probePortless(options.projectRoot);
  if (!probe.available || !probe.binary) {
    return { failed: true, reason: probe.reason ?? "portless is unavailable" };
  }

  const proxy = await ensureProxy(probe.binary);
  if (!proxy.ok) {
    return {
      failed: true,
      reason: `the portless proxy would not start${proxy.detail ? `: ${proxy.detail}` : ""}`,
    };
  }

  const listenPort = await findAvailablePort(identity.ports.app ?? 3000, {
    span: 200,
  });

  // `<slug>.<project>` keeps dots, so this becomes a three-label hostname and
  // tenant subdomains sit one level deeper — exactly the wildcard depth the
  // proxy resolves.
  const aliasName = portlessAliasName(identity);

  const registered = await portless(probe.binary, [
    "alias",
    aliasName,
    String(listenPort),
    "--force",
  ]);

  if (registered.code !== 0) {
    return {
      failed: true,
      reason: `could not register the hostname: ${registered.stderr.trim() || registered.stdout.trim()}`,
    };
  }

  const resolved = await portless(probe.binary, [
    "get",
    aliasName,
    "--no-worktree",
  ]);

  if (resolved.code !== 0 || !resolved.stdout.trim()) {
    return {
      failed: true,
      reason: "could not read the registered URL back from portless",
    };
  }

  const appUrl = resolved.stdout.trim();
  const rootDomain = new URL(appUrl).hostname;

  const providerEnv: Record<string, string> = {};
  const caPath = path.join(stateDir(), "ca.pem");
  if (fs.existsSync(caPath) && !process.env.NODE_EXTRA_CA_CERTS) {
    // Without this, server-side fetches from the app to its own HTTPS origin
    // fail certificate validation.
    providerEnv.NODE_EXTRA_CA_CERTS = caPath;
  }

  const url: UrlContext = {
    mode: "portless",
    appUrl,
    rootDomain,
    cookieDomain: `.${rootDomain}`,
    tenantUrlTemplate: `${new URL(appUrl).protocol}//<subdomain>.${rootDomain}`,
    wildcardOrigins: [rootDomain, `*.${rootDomain}`, `*.*.${rootDomain}`],
    listenHost: "127.0.0.1",
    listenPort,
    providerEnv,
  };

  return { url, aliasName };
}

/** Release a hostname. Alias routes are stored with pid 0, so nothing else reaps them. */
export async function releasePortlessAlias(
  projectRoot: string,
  aliasName: string,
): Promise<void> {
  const binary = findPortlessBinary(projectRoot);
  if (!binary) return;
  await portless(binary, ["alias", "--remove", aliasName], {
    timeoutMs: 30_000,
  }).catch(() => undefined);
}
