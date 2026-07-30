import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  WORKTRELLIS_CONFIG_VERSION,
  type ServiceSpec,
  type WorkTrellisConfig,
} from "../types";
import { WorkTrellisError, usageError } from "./errors";
import { assertProjectName } from "./naming";

const CONFIG_FILENAMES = [
  "worktrellis.config.ts",
  "worktrellis.config.mts",
  "worktrellis.config.js",
  "worktrellis.config.mjs",
];

export interface LoadedConfig {
  config: Required<
    Pick<WorkTrellisConfig, "configVersion" | "project" | "services" | "env" | "processes">
  > &
    WorkTrellisConfig;
  /** Directory containing the config file — the project root. */
  projectRoot: string;
  configPath: string;
}

/** Walk up from `startDir` looking for a WorkTrellis config file. */
export function findConfigFile(startDir: string): string | null {
  let current = path.resolve(startDir);

  for (;;) {
    for (const filename of CONFIG_FILENAMES) {
      const candidate = path.join(current, filename);
      if (fs.existsSync(candidate)) return candidate;
    }

    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export async function loadConfig(options: {
  cwd: string;
  configPath?: string;
}): Promise<LoadedConfig> {
  const configPath = options.configPath
    ? path.resolve(options.cwd, options.configPath)
    : findConfigFile(options.cwd);

  if (!configPath) {
    usageError(
      "No worktrellis.config.ts found.",
      `Looked in ${path.resolve(options.cwd)} and every parent directory.\nCreate a worktrellis.config.ts at your project root.`,
    );
  }

  if (!fs.existsSync(configPath)) {
    usageError(`Config file not found: ${configPath}`);
  }

  let loaded: unknown;
  try {
    const imported = (await import(pathToFileURL(configPath).href)) as {
      default?: unknown;
    };
    loaded = imported.default;
  } catch (caught) {
    throw new WorkTrellisError(`Failed to load ${path.basename(configPath)}.`, {
      cause: caught,
      remediation: (caught as Error)?.message,
    });
  }

  if (!loaded || typeof loaded !== "object") {
    usageError(
      `${path.basename(configPath)} must export a default WorkTrellis config.`,
      "Use `export default defineConfig({ ... })`.",
    );
  }

  const config = validate(loaded as WorkTrellisConfig, configPath);

  return {
    config,
    projectRoot: path.dirname(configPath),
    configPath,
  };
}

function validate(
  config: WorkTrellisConfig,
  configPath: string,
): LoadedConfig["config"] {
  const where = path.basename(configPath);

  if (config.configVersion !== WORKTRELLIS_CONFIG_VERSION) {
    usageError(
      `${where}: unsupported \`configVersion\` ${JSON.stringify(config.configVersion)}.`,
      `Set \`configVersion: ${WORKTRELLIS_CONFIG_VERSION}\`. Configuration versions change only when the file contract has a breaking change.`,
    );
  }

  if (typeof config.project !== "string") {
    usageError(`${where}: \`project\` is required and must be a string.`);
  }
  assertProjectName(config.project);

  if (!Array.isArray(config.services)) {
    usageError(`${where}: \`services\` is required and must be an array.`);
  }
  assertUniqueServiceKinds(config.services, where);

  if (typeof config.env !== "function") {
    usageError(
      `${where}: \`env\` is required and must be a function.`,
      "It receives the resolved workspace, service endpoints, and URL context, and returns the keys WorkTrellis owns.",
    );
  }

  if (!Array.isArray(config.processes)) {
    usageError(`${where}: \`processes\` is required and must be an array.`);
  }

  const names = new Set<string>();
  for (const process of config.processes) {
    if (!process.name) {
      usageError(`${where}: every entry in \`processes\` needs a \`name\`.`);
    }
    if (names.has(process.name)) {
      usageError(`${where}: duplicate process name "${process.name}".`);
    }
    names.add(process.name);
  }

  for (const process of config.processes) {
    for (const dependency of process.dependsOn ?? []) {
      if (!names.has(dependency)) {
        usageError(
          `${where}: process "${process.name}" depends on "${dependency}", which is not defined.`,
        );
      }
    }
  }
  assertAcyclicProcessDependencies(config.processes, where);

  const appProcesses = config.processes.filter((entry) => entry.bindsAppPort);
  if (appProcesses.length > 1) {
    usageError(
      `${where}: ${appProcesses.length} processes set \`bindsAppPort\`; only one can bind the app port.`,
    );
  }

  return config as LoadedConfig["config"];
}

function assertAcyclicProcessDependencies(
  processes: WorkTrellisConfig["processes"],
  where: string,
): void {
  const byName = new Map(processes.map((process) => [process.name, process]));
  const visiting: string[] = [];
  const complete = new Set<string>();

  const visit = (name: string): void => {
    if (complete.has(name)) return;

    const cycleAt = visiting.indexOf(name);
    if (cycleAt !== -1) {
      const cycle = [...visiting.slice(cycleAt), name].join(" -> ");
      usageError(`${where}: process dependency cycle: ${cycle}.`);
    }

    visiting.push(name);
    for (const dependency of byName.get(name)?.dependsOn ?? []) {
      visit(dependency);
    }
    visiting.pop();
    complete.add(name);
  };

  for (const process of processes) visit(process.name);
}

function assertUniqueServiceKinds(services: ServiceSpec[], where: string): void {
  const seen = new Set<string>();
  for (const service of services) {
    if (seen.has(service.kind)) {
      usageError(
        `${where}: service kind "${service.kind}" is declared more than once.`,
        "A project uses one instance of each service kind; versions are chosen per machine.",
      );
    }
    seen.add(service.kind);
  }
}
