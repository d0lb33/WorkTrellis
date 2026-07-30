import fs from "node:fs";
import path from "node:path";

import { usageError } from "./errors";

export interface WorkspaceLocalConfig {
  url?: {
    /**
     * Exact Portless alias below `.localhost`.
     *
     * For example, `stars-local` resolves to
     * `https://stars-local.localhost`.
     */
    hostname?: string;
  };
}

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

function assertKnownKeys(
  value: Record<string, unknown>,
  allowed: string[],
  where: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    usageError(
      `${where} contains unknown key${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`,
    );
  }
}

function validateHostname(value: unknown, where: string): string {
  if (typeof value !== "string" || value.length === 0) {
    usageError(`${where} must be a non-empty string.`);
  }
  if (value !== value.toLowerCase()) {
    usageError(`${where} must be lowercase.`);
  }
  if (
    value.includes("://") ||
    value.includes("/") ||
    value.includes(":") ||
    value.endsWith(".localhost")
  ) {
    usageError(
      `${where} must be a hostname below .localhost, not a URL.`,
      'Use a value such as "stars-local"; WorkTrellis adds https:// and .localhost.',
    );
  }
  if (value.length > 253) {
    usageError(`${where} must be at most 253 characters.`);
  }

  const labels = value.split(".");
  if (
    labels.some(
      (label) => label.length === 0 || label.length > 63 || !DNS_LABEL.test(label),
    )
  ) {
    usageError(
      `${where} must contain valid lowercase DNS labels.`,
      "Use letters, digits, and hyphens, with dots only between labels.",
    );
  }

  return value;
}

export function loadWorkspaceLocalConfig(
  filePath: string,
): WorkspaceLocalConfig {
  if (!fs.existsSync(filePath)) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (caught) {
    usageError(
      `Could not parse ${path.relative(path.dirname(path.dirname(filePath)), filePath)}.`,
      (caught as Error).message,
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    usageError(`${path.basename(filePath)} must contain a JSON object.`);
  }

  const local = parsed as Record<string, unknown>;
  assertKnownKeys(local, ["url"], path.basename(filePath));

  if (local.url === undefined) return {};
  if (!local.url || typeof local.url !== "object" || Array.isArray(local.url)) {
    usageError(`${path.basename(filePath)}: \`url\` must be an object.`);
  }

  const url = local.url as Record<string, unknown>;
  assertKnownKeys(url, ["hostname"], `${path.basename(filePath)}: \`url\``);

  if (url.hostname === undefined) return { url: {} };

  return {
    url: {
      hostname: validateHostname(
        url.hostname,
        `${path.basename(filePath)}: \`url.hostname\``,
      ),
    },
  };
}
