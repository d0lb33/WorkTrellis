#!/usr/bin/env node
// Command-line entry point for `pnpm exec worktrellis ...`.
//
// The CLI itself is compiled, but it runs through tsx so projects can keep a
// typed `worktrellis.config.ts` without installing a loader of their own.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "..", "dist", "cli.js");

let tsxCli;
try {
  const require = createRequire(import.meta.url);
  tsxCli = require.resolve("tsx/cli");
} catch {
  console.error(
    "WorkTrellis could not load its TypeScript runtime. Reinstall the worktrellis package.",
  );
  process.exit(3);
}

const child = spawn(process.execPath, [tsxCli, cli, ...process.argv.slice(2)], {
  stdio: "inherit",
  windowsHide: true,
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
