import fs from "node:fs";
import path from "node:path";

import type { Command, UrlContext, WorkspaceIdentity } from "../types";
import { redactDiagnosticText } from "../core/env-resolve";
import { findAvailablePort } from "../platform/ports";
import { run } from "../util/proc";

/**
 * Public HTTPS hostnames, delegated to the `portless` process wrapper.
 *
 * WorkTrellis supplies an exact worktree-safe name and deterministic port.
 * Portless owns proxy startup, route conflicts, registration, framework
 * adaptation, and cleanup. WorkTrellis supervises the Portless wrapper as the
 * foreground app process, so its existing tree-kill and orphan reaping still
 * cover the complete process tree.
 */

export interface PortlessProbe {
  available: boolean;
  reason?: string;
  binary?: string;
  version?: string;
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

  let version: string | undefined;
  try {
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(projectRoot, "node_modules", "portless", "package.json"),
        "utf8",
      ),
    ) as { version?: unknown };
    if (typeof manifest.version === "string") version = manifest.version;
  } catch {
    // The executable probe remains authoritative for ordinary local routing.
  }

  return { available: true, binary, version };
}

export function supportsReliablePortlessTailscale(
  version: string | undefined,
): boolean {
  if (!version) return false;
  const match = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (major !== 0) return major > 0;
  if (minor !== 15) return minor > 15;
  if (patch !== 5) return patch > 5;
  return !match[4]!.startsWith("-");
}

async function portless(
  binary: string,
  args: string[],
  options: { timeoutMs?: number } = {},
) {
  return run(process.execPath, [binary, ...args], {
    quiet: true,
    timeoutMs: options.timeoutMs ?? 60_000,
    env: { ...process.env },
  });
}

/**
 * Ask Portless to ensure its shared proxy is ready before WorkTrellis detaches
 * the supervised process tree. Retry interactively only when the terminal can
 * satisfy Portless's own first-run trust/elevation prompts.
 */
async function ensurePortlessProxy(
  binary: string,
  wildcard: boolean,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const args = ["proxy", "start", ...(wildcard ? ["--wildcard"] : [])];
  const quiet = await portless(binary, args, { timeoutMs: 120_000 });
  if (quiet.code === 0) return { ok: true };

  if (process.stdin.isTTY) {
    const interactive = await run(process.execPath, [binary, ...args], {
      timeoutMs: 120_000,
      stdin: "inherit",
      env: { ...process.env },
    });
    if (interactive.code === 0) return { ok: true };
  }

  return {
    ok: false,
    detail: redactDiagnosticText(
      `${quiet.stderr || quiet.stdout}`
        .trim()
        .split("\n")
        .slice(-3)
        .join(" "),
      process.env,
    ),
  };
}

export interface PortlessRegistration {
  url: UrlContext;
  /** App-process wrapper that delegates all hostname lifecycle to Portless. */
  appRunner: PortlessAppRunner;
  /** WorkTrellis claims no Portless route state itself. */
  release: () => Promise<void>;
}

export interface PortlessAppRunner {
  binary: string;
  aliasName: string;
  listenPort: number;
  tailscale: boolean;
  /** Portless 0.15.x joins Windows child argv into one cmd.exe string. */
  windowsCmdShell?: boolean;
  /** Allow Portless's own Tailscale CLI cleanup to finish before force-kill. */
  cooperativeShutdownGraceMs?: number;
}

export const PORTLESS_TAILSCALE_CLEANUP_GRACE_MS = 35_000;

/** Parse the provider-returned URL from Portless's documented CLI output. */
export function parsePortlessSharingUrl(line: string): string | null {
  const plain = line.replace(/\u001b\[[0-9;]*m/g, "");
  const match = /^\s*Tailscale\s*->\s*(https:\/\/\S+)\s*$/i.exec(plain);
  if (!match?.[1]) return null;
  try {
    const parsed = new URL(match[1]);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

/**
 * Let Portless own local routing and optional private sharing while
 * WorkTrellis continues to supervise the foreground process tree.
 */
export function wrapCommandForPortless(
  command: Command,
  runner: PortlessAppRunner,
  projectRoot: string,
): Command {
  const child =
    "node" in command
      ? [
          path.basename(process.execPath),
          path.resolve(projectRoot, command.node[0]!),
          ...command.node.slice(1),
        ]
      : [command.bin, ...command.args];
  const compatibleChild = runner.windowsCmdShell
    ? child.map(quoteWindowsCmdToken)
    : child;

  return {
    node: [
      runner.binary,
      "--name",
      runner.aliasName,
      ...(runner.tailscale ? ["--tailscale"] : []),
      "--app-port",
      String(runner.listenPort),
      "--",
      ...compatibleChild,
    ],
  };
}

/**
 * Portless 0.15.x invokes `cmd.exe /c` with `commandArgs.join(" ")` on
 * Windows. Quote only tokens that cmd would otherwise split or interpret.
 * The executable is normally the PATH-resolved `node.exe`, so a standard
 * `C:\Program Files\nodejs` installation never appears in this command.
 */
export function quoteWindowsCmdToken(value: string): string {
  if (!/[\s&|<>^()]/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}

/** The hostname this workspace uses, without contacting the proxy. */
export function portlessAliasName(
  identity: WorkspaceIdentity,
  hostname?: string,
): string {
  return hostname ?? `${identity.slug}.${identity.project}`;
}

/**
 * Describe the URL this workspace *would* use, registering nothing.
 *
 * Read-only commands must never contact or mutate Portless.
 */
export function previewPortlessUrl(
  identity: WorkspaceIdentity,
  listenPort: number,
  hostname?: string,
): UrlContext {
  const rootDomain = `${portlessAliasName(identity, hostname)}.localhost`;

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
  options: {
    projectRoot: string;
    hostname?: string;
    tailscale?: boolean;
    wildcard?: boolean;
  },
): Promise<PortlessRegistration | { failed: true; reason: string }> {
  const probe = probePortless(options.projectRoot);
  if (!probe.available || !probe.binary) {
    return { failed: true, reason: probe.reason ?? "portless is unavailable" };
  }
  if (options.tailscale && !supportsReliablePortlessTailscale(probe.version)) {
    return {
      failed: true,
      reason: `Portless 0.15.5 or newer is required for reliable tailnet WebSocket support (found ${probe.version ?? "an unknown version"})`,
    };
  }

  const proxy = await ensurePortlessProxy(
    probe.binary,
    options.wildcard ?? false,
  );
  if (!proxy.ok) {
    return {
      failed: true,
      reason: `portless could not start its proxy${proxy.detail ? `: ${proxy.detail}` : ""}`,
    };
  }

  const listenPort = await findAvailablePort(identity.ports.app ?? 3000, {
    span: 200,
  });

  // `<slug>.<project>` keeps dots, so this becomes a three-label hostname and
  // tenant subdomains sit one level deeper — exactly the wildcard depth the
  // proxy resolves.
  const aliasName = portlessAliasName(identity, options.hostname);

  const resolved = await portless(probe.binary, [
    "get",
    aliasName,
    "--no-worktree",
  ]);

  if (resolved.code !== 0 || !resolved.stdout.trim()) {
    return {
      failed: true,
      reason: "could not resolve the local URL through portless",
    };
  }

  const appUrl = resolved.stdout.trim();
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(appUrl);
  } catch {
    return {
      failed: true,
      reason: `portless returned an invalid URL: ${appUrl}`,
    };
  }
  const rootDomain = parsedUrl.hostname;

  const providerEnv: Record<string, string> = {};
  if (options.wildcard && process.env.PORTLESS_WILDCARD === undefined) {
    // WorkTrellis expresses that tenant routing is required; Portless owns how
    // the shared proxy satisfies and persists that requirement.
    providerEnv.PORTLESS_WILDCARD = "1";
  }

  const url: UrlContext = {
    mode: "portless",
    appUrl,
    rootDomain,
    cookieDomain: `.${rootDomain}`,
    tenantUrlTemplate: `${parsedUrl.protocol}//<subdomain>.${rootDomain}`,
    wildcardOrigins: [rootDomain, `*.${rootDomain}`, `*.*.${rootDomain}`],
    listenHost: "127.0.0.1",
    listenPort,
    providerEnv,
  };

  return {
    url,
    appRunner: {
      binary: probe.binary,
      aliasName,
      listenPort,
      tailscale: options.tailscale ?? false,
      windowsCmdShell: process.platform === "win32",
      ...(options.tailscale
        ? {
            cooperativeShutdownGraceMs:
              PORTLESS_TAILSCALE_CLEANUP_GRACE_MS,
          }
        : {}),
    },
    release: async () => {
      // Portless removes its process-backed route when the wrapped app exits.
    },
  };
}

/**
 * Remove a legacy static alias recorded by WorkTrellis 0.2.x.
 *
 * New launches are process-backed and cleaned up by Portless itself. Keep this
 * compatibility path so `worktrellis down` can still clean an old run record.
 */
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
