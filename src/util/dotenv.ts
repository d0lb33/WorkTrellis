import fs from "node:fs";

import { WorkTrellisError } from "../core/errors";
import { atomicWrite } from "./fs";

/**
 * Reading is permissive — it must cope with whatever a developer hand-wrote.
 * Writing is deliberately strict, because the generated snapshot is read back
 * by two different parsers that disagree about escapes: Node's built-in
 * `--env-file` parser, and the `dotenv` package that most tooling uses.
 *
 * They agree on `KEY="simple value"` and diverge on escaped quotes, embedded
 * newlines, and backslashes. Rather than emit something whose meaning depends
 * on who reads it, we refuse to serialize such a value at all.
 */

const KEY_LINE = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

function unquote(rawValue: string): string {
  const value = rawValue.trim();

  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value
      .slice(1, -1)
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }

  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }

  // Unquoted values end at the first " #" comment marker.
  const commentIndex = value.search(/\s#/);
  return (commentIndex === -1 ? value : value.slice(0, commentIndex)).trim();
}

export function parseEnv(content: string): Map<string, string> {
  const values = new Map<string, string>();

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const match = KEY_LINE.exec(line);
    if (!match) continue;

    const key = match[2];
    if (!key) continue;
    values.set(key, unquote(match[3] ?? ""));
  }

  return values;
}

export function readEnvFile(filePath: string): Map<string, string> {
  if (!fs.existsSync(filePath)) return new Map();
  return parseEnv(fs.readFileSync(filePath, "utf8"));
}

/** Values every supported parser reads back identically. */
function assertPortableValue(key: string, value: string): void {
  if (/["'\\\r\n]/.test(value)) {
    throw new WorkTrellisError(
      `Cannot write ${key} to the WorkTrellis snapshot: the value contains a quote, backslash, or newline.`,
      {
        remediation:
          "Node's --env-file parser and dotenv disagree about these escapes. Keep generated values simple, or move this key to the secrets file where only one parser reads it.",
      },
    );
  }
}

export interface SerializeOptions {
  /** Header comment lines, written without the leading "# ". */
  header?: string[];
}

/**
 * Render WorkTrellis-owned keys as a dotenv file.
 *
 * Keys whose value is `undefined` are OMITTED rather than written empty: some
 * loaders (notably Next's) treat an empty value as an instruction to delete the
 * variable, which would silently unset something the base env file provided.
 */
export function serializeEnv(
  values: Record<string, string | undefined>,
  options: SerializeOptions = {},
): string {
  const lines: string[] = [];

  for (const line of options.header ?? []) {
    lines.push(line.length > 0 ? `# ${line}` : "#");
  }
  if (lines.length > 0) lines.push("");

  for (const key of Object.keys(values).sort()) {
    const value = values[key];
    if (value === undefined || value === "") continue;
    assertPortableValue(key, value);
    lines.push(`${key}="${value}"`);
  }

  return `${lines.join("\n")}\n`;
}

export function writeEnvSnapshot(
  filePath: string,
  values: Record<string, string | undefined>,
  options: SerializeOptions = {},
): void {
  // atomicWrite refuses any `.env*` basename, so this can only ever target the
  // generated snapshot.
  atomicWrite(filePath, serializeEnv(values, options));
}
