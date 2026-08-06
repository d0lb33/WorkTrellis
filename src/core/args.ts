/**
 * Tiny argv parser. Deliberately not a dependency: WorkTrellis's whole value is
 * that it drops into any project without adding to its tree.
 *
 * Supports `--flag`, `--no-flag`, `--key=value`, `--key value`, `-q`, and a
 * `--` terminator after which everything is passed through verbatim.
 */
export interface ParsedArgs {
  command: string | null;
  subcommand: string | null;
  positionals: string[];
  flags: Map<string, string | boolean>;
  /** Everything after a bare `--`. */
  passthrough: string[];
}

const VALUE_EXPECTED = new Set([
  "only",
  "seed",
  "raw",
  "from",
  "max-idle-days",
  "cwd",
  "config",
  "print",
  "tail",
  "project",
  "tenant",
  "new-variant",
  "variant",
  "bind-address",
  "connect-host",
]);

function expectsValue(flag: string): boolean {
  // Any named-port override takes a value, including stack-qualified names, so
  // the parser does not need to enumerate project infrastructure.
  return VALUE_EXPECTED.has(flag) || /-port$/.test(flag);
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string | boolean>();
  const positionals: string[] = [];
  const passthrough: string[] = [];

  let terminated = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;

    if (terminated) {
      passthrough.push(token);
      continue;
    }

    if (token === "--") {
      terminated = true;
      continue;
    }

    if (token.startsWith("--")) {
      const body = token.slice(2);
      const equals = body.indexOf("=");

      if (equals !== -1) {
        flags.set(body.slice(0, equals), body.slice(equals + 1));
        continue;
      }

      if (body.startsWith("no-")) {
        flags.set(body.slice(3), false);
        continue;
      }

      const next = argv[index + 1];
      if (expectsValue(body) && next !== undefined && !next.startsWith("-")) {
        flags.set(body, next);
        index += 1;
        continue;
      }

      flags.set(body, true);
      continue;
    }

    if (token.startsWith("-") && token.length > 1) {
      for (const letter of token.slice(1)) {
        flags.set(letter, true);
      }
      continue;
    }

    positionals.push(token);
  }

  return {
    command: positionals[0] ?? null,
    subcommand: positionals[1] ?? null,
    positionals: positionals.slice(1),
    flags,
    passthrough,
  };
}

export function flagString(
  args: ParsedArgs,
  name: string,
): string | undefined {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

export function flagBoolean(
  args: ParsedArgs,
  name: string,
  fallback = false,
): boolean {
  const value = args.flags.get(name);
  if (value === undefined) return fallback;
  return value !== false && value !== "false";
}

/** Comma-separated list flag, e.g. `--only app,worker`. */
export function flagList(args: ParsedArgs, name: string): string[] | undefined {
  const value = flagString(args, name);
  if (value === undefined) return undefined;
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}
