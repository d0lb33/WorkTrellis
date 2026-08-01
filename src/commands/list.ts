import fs from "node:fs";

import { EXIT } from "../core/errors";
import { readWorkspaceRecords, type WorkspaceRecord } from "../core/state";
import { c, heading, info } from "../util/log";

export interface ListOptions {
  project?: string;
  json?: boolean;
}

function relativeAge(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "unknown";

  const minutes = Math.max(0, Math.round((Date.now() - then) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  return `${Math.round(hours / 24)}d ago`;
}

export function runList(options: ListOptions): number {
  const records = readWorkspaceRecords({ project: options.project });

  if (options.json) {
    console.log(
      JSON.stringify(
        records.map((record) => ({
          ...record,
          worktreeExists: fs.existsSync(record.worktreeRoot),
        })),
        null,
        2,
      ),
    );
    return EXIT.ok;
  }

  if (records.length === 0) {
    info("No workspaces recorded on this machine yet.");
    info(c.gray("Run `worktrellis up` in a project to register one."));
    return EXIT.ok;
  }

  const byProject = new Map<string, WorkspaceRecord[]>();
  for (const record of records) {
    const bucket = byProject.get(record.project) ?? [];
    bucket.push(record);
    byProject.set(record.project, bucket);
  }

  for (const [project, entries] of byProject) {
    heading(project);

    const rows = entries.map((record) => {
      const exists = fs.existsSync(record.worktreeRoot);
      return {
        slug: record.slug,
        branch: record.branch ?? "detached",
        seen: relativeAge(record.lastSeenAt),
        path: exists ? record.worktreeRoot : c.yellow(`${record.worktreeRoot} (missing)`),
      };
    });

    const width = (pick: (row: (typeof rows)[number]) => string) =>
      rows.reduce((max, row) => Math.max(max, pick(row).length), 0);

    const slugWidth = width((row) => row.slug);
    const branchWidth = width((row) => row.branch);
    for (const row of rows) {
      info(
        `  ${c.cyan(row.slug.padEnd(slugWidth))}  ` +
          `${row.branch.padEnd(branchWidth)}  ` +
          `${c.gray(row.seen)}`,
      );
      info(`    ${c.gray(row.path)}`);
      const record = entries.find((entry) => entry.slug === row.slug);
      for (const stack of record?.composeProjects ?? []) {
        info(
          `    ${c.gray(`${stack.name}: ${stack.projectName}${
            stack.projectName !== stack.compatibilityId
              ? ` (desired ${stack.compatibilityId})`
              : ""
          }`)}`,
        );
      }
    }

    info("");
  }

  return EXIT.ok;
}
