import { spawn } from "node:child_process";
import type { Readable } from "node:stream";

import { killTree } from "../util/proc";

export interface ManagedProcess {
  pid: number | null;
  stdout: Readable | null;
  stderr: Readable | null;
  onceError(listener: (error: Error) => void): void;
  onceExit(listener: (code: number) => void): void;
  forceTerminate(exitCode?: number): boolean;
}

export interface ManagedProcessOptions {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export function mergeManagedProcessEnvironment(
  sources: NodeJS.ProcessEnv[],
  caseInsensitive = process.platform === "win32",
): NodeJS.ProcessEnv {
  if (!caseInsensitive) return Object.assign({}, ...sources);

  const merged = new Map<string, { key: string; value: string }>();
  for (const source of sources) {
    for (const [key, value] of Object.entries(source)) {
      const canonical = key.toUpperCase();
      if (value === undefined) {
        merged.delete(canonical);
      } else {
        merged.set(canonical, { key, value });
      }
    }
  }

  return Object.fromEntries(
    [...merged.values()].map(({ key, value }) => [key, value]),
  );
}

export async function spawnManagedProcess(
  options: ManagedProcessOptions,
): Promise<ManagedProcess> {
  if (process.platform === "win32") {
    const { spawnWindowsJobProcess } = await import("./windows-job-process");
    return spawnWindowsJobProcess(options);
  }

  const child = spawn(options.file, options.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  return {
    pid: child.pid ?? null,
    stdout: child.stdout,
    stderr: child.stderr,
    onceError: (listener) => child.once("error", listener),
    onceExit: (listener) => {
      child.once("exit", (code, signal) => {
        listener(code ?? (signal ? 143 : 0));
      });
    },
    forceTerminate: () =>
      child.pid ? killTree(child.pid, "SIGKILL") : false,
  };
}
