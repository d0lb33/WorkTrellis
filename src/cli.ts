import fs from "node:fs";

import { parseArgs, flagBoolean, flagList, flagString } from "./core/args";
import { runUp } from "./commands/up";
import { WorkTrellisError, EXIT } from "./core/errors";
import { redactDiagnosticText } from "./core/env-resolve";
import { runDoctor } from "./commands/doctor";
import {
  runDb,
  runDown,
  runExec,
  runScript,
  runStatus,
  runUrl,
} from "./commands/misc";
import { runEnv } from "./commands/env";
import { runInfo } from "./commands/info";
import { runList } from "./commands/list";
import { runSelfCheck } from "./commands/self-check";
import { runServices } from "./commands/services";
import { c, error, info, setQuiet } from "./util/log";

// Quietly honor downstream pipe closure (`worktrellis list | head`) instead of
// turning a successful partial read into an uncaught EPIPE stack trace.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (caught: NodeJS.ErrnoException) => {
    if (caught.code === "EPIPE") process.exit(EXIT.ok);
    throw caught;
  });
}

const USAGE = `
${c.bold("worktrellis")} - one host, many worktrees

${c.bold("Usage:")}  worktrellis <command> [options]

${c.bold("Daily:")}
  up                       Start services, provision this worktree, run the app
  down                     Stop this worktree's processes
  status                   What is running, and where
  doctor                   Diagnose the environment and report fixes

${c.bold("Environment:")}
  env                      Show the resolved environment  [--explain] [--json]
  exec -- <cmd>            Run a command with the resolved environment
  run <script>             Run a package script with the resolved environment

${c.bold("Infrastructure:")}
  services up|down|restart|status|logs|variants|reconcile|adopt
  db url|migrate|seed|reset

${c.bold("Introspection:")}
  info                     This worktree's identity and derived names
  list                     Every worktree WorkTrellis knows about
  url                      This worktree's URL  [--tenant <sub>]
  self-check               Verify WorkTrellis stayed project-agnostic

${c.bold("Global options:")}
  --cwd <dir>              Run as if from another directory
  --config <file>          Use a specific WorkTrellis config file
  --tailscale              Ask Portless to share the app on your tailnet
  --json                   Machine-readable output where supported
  --no-color               Disable ANSI color
  -q, --quiet              Only errors
  -v, --version            Print the installed version
  -h, --help               This message
`.trimStart();

function installedVersion(): string {
  const manifestUrl = new URL("../package.json", import.meta.url);
  const manifest = JSON.parse(fs.readFileSync(manifestUrl, "utf8")) as {
    version?: string;
  };
  return manifest.version ?? "unknown";
}

type CommandHandler = (
  args: ReturnType<typeof parseArgs>,
) => number | Promise<number>;

const COMMANDS: Record<string, CommandHandler> = {
  "self-check": () => runSelfCheck(),
  info: (args) =>
    runInfo({
      cwd: flagString(args, "cwd"),
      configPath: flagString(args, "config"),
      json: flagBoolean(args, "json"),
    }),
  list: (args) =>
    runList({
      project: flagString(args, "project"),
      json: flagBoolean(args, "json"),
    }),
  up: (args) => {
    const seedFlag = args.flags.get("seed");
    return runUp({
      cwd: flagString(args, "cwd"),
      configPath: flagString(args, "config"),
      only: flagList(args, "only"),
      services: flagBoolean(args, "services", true),
      urlPreference: flagBoolean(args, "direct")
        ? "direct"
        : flagBoolean(args, "portless")
          ? "portless"
          : undefined,
      migrate: flagBoolean(args, "migrate"),
      seed: typeof seedFlag === "string" ? seedFlag : seedFlag === true,
      prefix: flagBoolean(args, "prefix", true),
      raw: flagString(args, "raw"),
      tailscale: args.flags.has("tailscale")
        ? flagBoolean(args, "tailscale")
        : undefined,
      newVariants: flagList(args, "new-variant"),
    });
  },
  down: (args) =>
    runDown({
      cwd: flagString(args, "cwd"),
      configPath: flagString(args, "config"),
    }),
  status: (args) =>
    runStatus({
      cwd: flagString(args, "cwd"),
      configPath: flagString(args, "config"),
      json: flagBoolean(args, "json"),
    }),
  url: (args) =>
    runUrl({
      cwd: flagString(args, "cwd"),
      configPath: flagString(args, "config"),
      json: flagBoolean(args, "json"),
      tenant: flagString(args, "tenant"),
    }),
  exec: (args) =>
    runExec({
      cwd: flagString(args, "cwd"),
      configPath: flagString(args, "config"),
      argv: args.passthrough,
    }),
  run: (args) =>
    runScript({
      cwd: flagString(args, "cwd"),
      configPath: flagString(args, "config"),
      script: args.positionals[0],
      argv: [...args.positionals.slice(1), ...args.passthrough],
    }),
  db: (args) =>
    runDb({
      cwd: flagString(args, "cwd"),
      configPath: flagString(args, "config"),
      subcommand: args.subcommand,
      seed: flagString(args, "seed"),
    }),
  doctor: (args) =>
    runDoctor({
      cwd: flagString(args, "cwd"),
      configPath: flagString(args, "config"),
      json: flagBoolean(args, "json"),
    }),
  env: (args) =>
    runEnv({
      cwd: flagString(args, "cwd"),
      configPath: flagString(args, "config"),
      json: flagBoolean(args, "json"),
      explain: flagBoolean(args, "explain"),
      print: flagString(args, "print"),
      direct: flagBoolean(args, "direct"),
    }),
  services: (args) =>
    runServices({
      cwd: flagString(args, "cwd"),
      configPath: flagString(args, "config"),
      subcommand: args.subcommand,
      service: args.positionals[1],
      json: flagBoolean(args, "json"),
      tail: Number(flagString(args, "tail") ?? 100),
      follow: flagBoolean(args, "follow"),
      volumes: flagBoolean(args, "volumes"),
      variant: flagString(args, "variant"),
      from: flagString(args, "from"),
      newVariants: flagList(args, "new-variant"),
      portOverrides: collectPortOverrides(args),
    }),
};

/**
 * `--database-port 5433` or `--local.database-port 5433`, for
 * `worktrellis services adopt`.
 */
function collectPortOverrides(
  args: ReturnType<typeof parseArgs>,
): Record<string, number> {
  const overrides: Record<string, number> = {};

  for (const [flag, value] of args.flags) {
    // camelCase is allowed for secondary ports. A stack-qualified key targets
    // one stack without overriding an identically named port elsewhere.
    const match =
      /^([a-z][a-zA-Z0-9-]*(?:\.[a-z][a-zA-Z0-9]*)?)-port$/.exec(flag);
    if (!match || typeof value !== "string") continue;

    const port = Number.parseInt(value, 10);
    if (Number.isInteger(port) && port > 0 && port < 65_536) {
      overrides[match[1]!] = port;
    }
  }

  return overrides;
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);

  if (flagBoolean(args, "quiet") || flagBoolean(args, "q")) {
    setQuiet(true);
  }

  if (flagBoolean(args, "version") || flagBoolean(args, "v")) {
    info(installedVersion());
    return EXIT.ok;
  }

  if (args.command === null || flagBoolean(args, "help") || flagBoolean(args, "h")) {
    info(USAGE);
    return flagBoolean(args, "help") || flagBoolean(args, "h")
      ? EXIT.ok
      : EXIT.usage;
  }

  const handler = COMMANDS[args.command];
  if (!handler) {
    error(`Unknown command "${args.command}".`);
    info("");
    info(USAGE);
    return EXIT.usage;
  }

  return await handler(args);
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((caught: unknown) => {
    if (caught instanceof WorkTrellisError) {
      error(redactDiagnosticText(caught.message, process.env));
      if (caught.remediation) {
        info("");
        for (const line of redactDiagnosticText(
          caught.remediation,
          process.env,
        ).split("\n")) {
          info(`    ${line}`);
        }
      }
      process.exitCode = caught.code;
      return;
    }

    // Anything that is not a WorkTrellisError is a bug in WorkTrellis itself, so the
    // stack trace is the useful output.
    error("WorkTrellis hit an unexpected error:");
    console.error(
      redactDiagnosticText(
        caught instanceof Error ? caught.stack ?? caught.message : String(caught),
        process.env,
      ),
    );
    process.exitCode = EXIT.checkFailed;
  });
