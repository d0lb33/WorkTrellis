import { WorkTrellisError } from "./errors";

/**
 * Every isolated resource name is derived here, and every derived name is
 * asserted against the rules of the system that will receive it. A name that is
 * wrong should fail at config load with a clear message, not later inside a
 * `CREATE DATABASE` or a bucket API call.
 */

export const MAX_DNS_LABEL = 63;
export const MAX_PG_IDENTIFIER = 63;
export const MAX_BUCKET_NAME = 63;
export const MIN_BUCKET_NAME = 3;

/** Length budget for the human-readable half of a slug. */
export const MAX_SLUG_LABEL = 20;
export const FINGERPRINT_LENGTH = 8;

const DNS_LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const PG_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const BUCKET_NAME = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

/** Lowercase, replace runs of unsupported characters, trim separators. */
export function sanitizeLabel(input: string, maxLength = MAX_DNS_LABEL): string {
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");

  return cleaned.slice(0, maxLength).replace(/-+$/, "");
}

export function toSnake(input: string): string {
  return input.replace(/-/g, "_");
}

/**
 * Shorten a composed name to fit a length budget while preserving the trailing
 * uniqueness token. Truncating the prefix is safe; truncating the fingerprint
 * would let two worktrees collide, which is the one thing that must not happen.
 */
function fitWithSuffix(
  prefix: string,
  separator: string,
  suffix: string,
  maxLength: number,
): string {
  const full = `${prefix}${separator}${suffix}`;
  if (full.length <= maxLength) return full;

  const room = maxLength - suffix.length - separator.length;
  if (room < 1) {
    throw new WorkTrellisError(
      `Cannot build a name within ${maxLength} characters while preserving the uniqueness suffix "${suffix}".`,
      { remediation: "Shorten the `project` name in worktrellis.config.ts." },
    );
  }

  const trimmed = prefix.slice(0, room).replace(/[-_]+$/, "");
  return `${trimmed}${separator}${suffix}`;
}

export function assertProjectName(project: string): void {
  if (!DNS_LABEL.test(project) || project.length > MAX_SLUG_LABEL) {
    throw new WorkTrellisError(
      `Invalid project name "${project}".`,
      {
        remediation: `A project name must be a DNS label (lowercase letters, digits, hyphens; no leading or trailing hyphen) of at most ${MAX_SLUG_LABEL} characters.`,
      },
    );
  }

  // Postgres identifiers cannot start with a digit, and the project name leads
  // every generated database name.
  if (/^[0-9]/.test(project)) {
    throw new WorkTrellisError(
      `Invalid project name "${project}": it must not start with a digit.`,
      { remediation: "Database names are derived from it and cannot start with a digit." },
    );
  }
}

export function buildSlug(label: string, fingerprint: string): string {
  const safeLabel = sanitizeLabel(label, MAX_SLUG_LABEL) || "workspace";
  const slug = `${safeLabel}-${fingerprint}`;
  assertDnsLabel(slug, "slug");
  return slug;
}

export function assertDnsLabel(value: string, what: string): void {
  if (!DNS_LABEL.test(value) || value.length > MAX_DNS_LABEL) {
    throw new WorkTrellisError(`Derived ${what} "${value}" is not a valid DNS label.`);
  }
}

/** Split a slug back into its human label and its uniqueness fingerprint. */
function splitSlug(slug: string): { label: string; fingerprint: string } {
  return {
    label: slug.slice(0, -(FINGERPRINT_LENGTH + 1)),
    fingerprint: slug.slice(-FINGERPRINT_LENGTH),
  };
}

export function buildDatabaseName(project: string, slug: string): string {
  const { label, fingerprint } = splitSlug(slug);
  const name = fitWithSuffix(
    `${toSnake(project)}_${toSnake(label)}`,
    "_",
    fingerprint,
    MAX_PG_IDENTIFIER,
  );

  if (!PG_IDENTIFIER.test(name)) {
    throw new WorkTrellisError(
      `Derived database name "${name}" is not a valid Postgres identifier.`,
    );
  }
  return name;
}

export function buildTemplateDatabaseName(
  project: string,
  fingerprint: string,
): string {
  const name = `${toSnake(project)}_tpl_${fingerprint.slice(0, 12)}`;
  if (!PG_IDENTIFIER.test(name) || name.length > MAX_PG_IDENTIFIER) {
    throw new WorkTrellisError(
      `Derived template database name "${name}" is not a valid Postgres identifier.`,
    );
  }
  return name;
}

export function buildBucketName(project: string, slug: string): string {
  const { label, fingerprint } = splitSlug(slug);
  const name = fitWithSuffix(
    `${project}-${label}`,
    "-",
    fingerprint,
    MAX_BUCKET_NAME,
  );

  // Dots are legal in bucket names but break virtual-host-style TLS and can
  // make a name look like an IP address, so they are excluded by sanitizing.
  if (
    !BUCKET_NAME.test(name) ||
    name.length < MIN_BUCKET_NAME ||
    name.length > MAX_BUCKET_NAME
  ) {
    throw new WorkTrellisError(`Derived bucket name "${name}" is not a valid bucket name.`);
  }
  return name;
}

/**
 * Braces make the whole prefix a single cluster hash slot, which queue systems
 * require when a group of keys must live together.
 *
 * No trailing separator: consumers differ about whether they add one, so the
 * caller appends it when the consumer concatenates raw (a client-level key
 * prefix) and omits it when the consumer inserts its own (a queue namespace).
 */
export function buildRedisPrefix(project: string, slug: string): string {
  return `{${project}:${slug}}`;
}
