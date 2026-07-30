import { createHash } from "node:crypto";
import fs from "node:fs";

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function sha1(input: string): string {
  return createHash("sha1").update(input).digest("hex");
}

/**
 * Fingerprint a set of paths. Directories are walked deterministically so the
 * same tree always produces the same digest regardless of readdir order.
 * Missing paths contribute a marker rather than throwing, so a fingerprint stays
 * meaningful when an optional input is absent.
 */
export function fingerprintPaths(paths: string[]): string {
  const hash = createHash("sha256");

  for (const target of [...paths].sort()) {
    hash.update(`\0path:${target}\0`);
    absorb(hash, target);
  }

  return hash.digest("hex");
}

function absorb(hash: ReturnType<typeof createHash>, target: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch {
    hash.update("<missing>");
    return;
  }

  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(target).sort()) {
      hash.update(`\0entry:${entry}\0`);
      absorb(hash, `${target}/${entry}`);
    }
    return;
  }

  hash.update(fs.readFileSync(target));
}

/** Map a hex fingerprint into [0, modulus). */
export function hexModulo(hex: string, modulus: number): number {
  const slice = Number.parseInt(hex.slice(0, 8), 16);
  return Number.isFinite(slice) ? slice % modulus : 0;
}
