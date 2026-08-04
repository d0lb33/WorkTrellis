#!/usr/bin/env node
// Command-line entry point for `pnpm exec worktrellis ...`.
//
// The CLI itself is compiled, but it runs through tsx so projects can keep a
// typed `worktrellis.config.ts` without installing a loader of their own.

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "..", "dist", "cli.js");

let register;
try {
  ({ register } = await import("tsx/esm/api"));
} catch {
  console.error(
    "WorkTrellis could not load its TypeScript runtime. Reinstall the worktrellis package.",
  );
  process.exit(3);
}

// Run the compiled CLI in this process. An npm-bin relay process exits on the
// first Windows Ctrl+C before the real supervisor finishes its async cleanup,
// returning Git Bash to a prompt while descendants are still shutting down.
register();
await import(pathToFileURL(cli).href);
