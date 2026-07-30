import path from "node:path";

import { displayValue } from "../core/env-resolve";
import { EXIT } from "../core/errors";
import { prepareWorkspace } from "../core/prepare";
import { c, heading, info, table, warn } from "../util/log";

export interface EnvOptions {
  cwd?: string;
  configPath?: string;
  json?: boolean;
  explain?: boolean;
  print?: string;
  direct?: boolean;
}

export async function runEnv(options: EnvOptions): Promise<number> {
  const prepared = await prepareWorkspace({
    cwd: options.cwd,
    configPath: options.configPath,
    startServices: false,
    peekUrl: true,
    urlPreference: options.direct ? "direct" : undefined,
  });

  const { env, context } = prepared;

  if (options.print) {
    const value = env.combined[options.print];
    if (value === undefined) return EXIT.checkFailed;
    // Printed raw and unadorned so it can be captured by a shell.
    process.stdout.write(`${value}\n`);
    return EXIT.ok;
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          owned: env.owned,
          conflicts: env.conflicts,
          snapshot: context.paths.env,
        },
        null,
        2,
      ),
    );
    return EXIT.ok;
  }

  heading(`Environment for ${c.cyan(context.identity.slug)}`);
  info("");

  if (options.explain) {
    const keys = Object.keys(env.combined).sort();
    const rows: Array<[string, string]> = keys.map((key) => {
      const owned = env.owned[key];
      const source = owned !== undefined ? "worktrellis" : "secrets file";
      const value = displayValue(key, env.combined[key] ?? "");
      const overridden =
        owned !== undefined && context.baseEnv.has(key) && context.baseEnv.get(key) !== owned;
      return [
        key,
        `${c.gray(source.padEnd(13))} ${value}${
          overridden ? c.yellow("   (secrets file value ignored)") : ""
        }`,
      ];
    });
    table(rows);
  } else {
    table(
      Object.keys(env.owned)
        .sort()
        .map((key) => [key, displayValue(key, env.owned[key] ?? "")]),
    );
    info("");
    info(
      c.gray(
        `  ${Object.keys(env.owned).length} WorkTrellis-managed keys, plus ${context.baseEnv.size} from ${path.basename(context.baseEnvPath)}.`,
      ),
    );
    info(c.gray("  Run with --explain to see every key and where it came from."));
  }

  info("");
  info(
    `  snapshot  ${c.gray(path.relative(context.projectRoot, context.paths.env))}`,
  );

  if (env.conflicts.length > 0) {
    info("");
    warn(
      `${env.conflicts.length} key(s) in ${path.basename(context.baseEnvPath)} are also managed by WorkTrellis. The WorkTrellis value wins; the file is not modified.`,
    );
    info("");
    for (const conflict of env.conflicts) {
      const marker = conflict.severity === "critical" ? c.red("critical") : c.gray("info");
      info(`  ${marker}  ${c.bold(conflict.key)}`);
      info(`    file      ${displayValue(conflict.key, conflict.baseValue)}`);
      info(`    worktrellis  ${displayValue(conflict.key, conflict.ownedValue)}`);
    }
    info("");
    info(
      c.gray(
        `  Remove them from ${path.basename(context.baseEnvPath)} to silence this. \`worktrellis doctor\` fails on the critical ones.`,
      ),
    );
  }

  return EXIT.ok;
}
