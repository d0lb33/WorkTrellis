import fs from "node:fs";
import path from "node:path";

import { WorkTrellisError } from "../core/errors";

/**
 * Files WorkTrellis must never write. The developer's env files hold secrets and
 * hand-managed values; the entire point of the generated snapshot is that those
 * files stay untouched. This is enforced here, in the one function that writes,
 * so no future call site can quietly reintroduce env mutation.
 */
const PROTECTED_BASENAME = /^\.env(\..*)?$/;

export function assertWritablePath(filePath: string): void {
  const basename = path.basename(filePath);
  if (PROTECTED_BASENAME.test(basename)) {
    throw new WorkTrellisError(
      `WorkTrellis refused to write ${basename}: env files are read-only to tooling.`,
      {
        remediation:
          "Emit the value from the config env profile instead; it lands in the generated snapshot.",
      },
    );
  }
}

/**
 * Write a file atomically: temp file in the same directory, then rename.
 * A crash mid-write can never leave a half-written snapshot that another
 * process would happily parse.
 */
export function atomicWrite(
  filePath: string,
  contents: string,
  options: { mode?: number } = {},
): void {
  assertWritablePath(filePath);

  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });

  const temp = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.tmp`,
  );

  try {
    fs.writeFileSync(temp, contents, { mode: options.mode ?? 0o600 });
    fs.renameSync(temp, filePath);
  } catch (caught) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // Best effort.
    }
    throw caught;
  }
}

export function readJsonFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

export function writeJsonFile(filePath: string, value: unknown): void {
  atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function ensureDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true });
}

/** realpath + separator normalization, so a path is one canonical string. */
export function normalizePath(target: string): string {
  let resolved: string;
  try {
    resolved = fs.realpathSync.native(target);
  } catch {
    resolved = path.resolve(target);
  }

  let normalized = resolved.replace(/\\/g, "/").replace(/\/+$/, "");

  // Only case-fold where the filesystem is genuinely case-insensitive; doing it
  // on Linux would merge two legitimately distinct worktrees.
  if (process.platform === "win32" || process.platform === "darwin") {
    normalized = normalized.toLowerCase();
  }

  return normalized;
}
