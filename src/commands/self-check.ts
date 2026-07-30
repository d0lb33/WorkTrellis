import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { EXIT } from "../core/errors";
import { c, error, heading, info, success } from "../util/log";

function findPackageRoot(start: string): string {
  let current = start;
  for (;;) {
    const manifest = path.join(current, "package.json");
    if (fs.existsSync(manifest)) return current;
    const parent = path.dirname(current);
    if (parent === current) return start;
    current = parent;
  }
}

const PACKAGE_ROOT = findPackageRoot(
  path.dirname(fileURLToPath(import.meta.url)),
);
const WORKTRELLIS_SRC = path.join(PACKAGE_ROOT, "src");

/**
 * Vocabulary that must never appear in WorkTrellis's own source. These are the
 * names of one specific project's stack; if any of them shows up here, project
 * knowledge has leaked past `worktrellis.config.ts` and extraction would break.
 *
 * Protocol names used by optional resource adapters are deliberately not on
 * this list. Container images and application vocabulary must remain in the
 * consuming project.
 */
const FORBIDDEN_TERMS = [
  "stars",
  "ycp",
  "prisma",
  "bullmq",
  "better-auth",
  "better_auth",
  "next.js",
  "nextjs",
  "DATABASE_URL",
  "S3_BUCKET",
  "BETTER_AUTH",
  "t3-oss",
];

/** Files whose prose legitimately discusses the host project. */
const EXEMPT_FILES = new Set(["self-check.ts"]);

interface Violation {
  file: string;
  line: number;
  term: string;
  text: string;
}

function collectSourceFiles(directory: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(full, found);
    } else if (entry.name.endsWith(".ts")) {
      found.push(full);
    }
  }
  return found;
}

export function runSelfCheck(): number {
  heading("worktrellis self-check");
  info("");

  const violations: Violation[] = [];
  const files = collectSourceFiles(WORKTRELLIS_SRC);

  for (const file of files) {
    if (EXEMPT_FILES.has(path.basename(file))) continue;

    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((text, index) => {
      for (const term of FORBIDDEN_TERMS) {
        if (text.toLowerCase().includes(term.toLowerCase())) {
          violations.push({
            file: path.relative(WORKTRELLIS_SRC, file),
            line: index + 1,
            term,
            text: text.trim(),
          });
        }
      }
    });
  }

  info(`  scanned ${files.length} source files`);

  if (violations.length === 0) {
    info("");
    success("No host-project vocabulary found. The tool is portable.");
    return EXIT.ok;
  }

  info("");
  error(
    `${violations.length} reference(s) to host-project vocabulary in WorkTrellis source:`,
  );
  info("");
  for (const violation of violations) {
    info(
      `  ${c.cyan(`${violation.file}:${violation.line}`)}  ${c.yellow(violation.term)}`,
    );
    info(`    ${c.gray(violation.text.slice(0, 120))}`);
  }
  info("");
  info(
    "  Move this knowledge into the project's worktrellis.config.ts and take it through the config types.",
  );

  return EXIT.checkFailed;
}
