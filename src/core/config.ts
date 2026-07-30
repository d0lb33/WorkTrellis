import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  WORKTRELLIS_CONFIG_VERSION,
  type AnyResourceAdapter,
  type ComposeStackSpec,
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
    Pick<
      WorkTrellisConfig,
      "configVersion" | "project" | "compose" | "env" | "processes"
    >
  > &
    WorkTrellisConfig;
  projectRoot: string;
  configPath: string;
}

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

  return {
    config: validate(loaded as WorkTrellisConfig, configPath),
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
      `${where}: this release requires \`configVersion: ${WORKTRELLIS_CONFIG_VERSION}\`; received ${JSON.stringify(config.configVersion)}.`,
      "Configuration v1 is intentionally not supported. Migrate the configuration before upgrading WorkTrellis.",
    );
  }

  if (typeof config.project !== "string") {
    usageError(`${where}: \`project\` is required and must be a string.`);
  }
  assertProjectName(config.project);

  if (!Array.isArray(config.compose)) {
    usageError(`${where}: \`compose\` is required and must be an array.`);
  }
  validateCompose(config.compose, where);

  if (typeof config.env !== "function") {
    usageError(
      `${where}: \`env\` is required and must be a function.`,
      "It receives workspace identity, Compose endpoints, isolated resources, and the application URL.",
    );
  }

  if (!Array.isArray(config.processes)) {
    usageError(`${where}: \`processes\` is required and must be an array.`);
  }
  validateProcesses(config, where);

  const stackNames = new Set(config.compose.map((stack) => stack.name));
  for (const [name, resource] of Object.entries(config.resources ?? {})) {
    validateResource(name, resource, stackNames, config.compose, where);
  }

  if (config.db) {
    const adapter = config.resources?.[config.db.resource];
    if (!adapter) {
      usageError(
        `${where}: \`db.resource\` references unknown resource "${config.db.resource}".`,
      );
    }
    if (adapter.kind !== "postgres-database") {
      usageError(
        `${where}: \`db.resource\` must reference a postgresDatabase() adapter.`,
      );
    }
  }

  return config as LoadedConfig["config"];
}

function validateCompose(stacks: ComposeStackSpec[], where: string): void {
  const names = new Set<string>();
  for (const stack of stacks) {
    if (!/^[a-z][a-z0-9-]*$/.test(stack.name)) {
      usageError(
        `${where}: Compose stack name ${JSON.stringify(stack.name)} is invalid.`,
        "Use a lowercase DNS label beginning with a letter.",
      );
    }
    if (names.has(stack.name)) {
      usageError(`${where}: duplicate Compose stack name "${stack.name}".`);
    }
    names.add(stack.name);

    if (!["machine", "repository", "workspace"].includes(stack.scope)) {
      usageError(
        `${where}: Compose stack "${stack.name}" has invalid scope ${JSON.stringify(stack.scope)}.`,
      );
    }
    if (!Array.isArray(stack.files) || stack.files.length === 0) {
      usageError(
        `${where}: Compose stack "${stack.name}" needs at least one project-owned file.`,
      );
    }
    for (const file of stack.files) {
      if (typeof file !== "string" || file.trim() === "") {
        usageError(
          `${where}: Compose stack "${stack.name}" contains an invalid file path.`,
        );
      }
    }

    const portNames = new Set<string>();
    for (const [portName, port] of Object.entries(stack.ports ?? {})) {
      if (!/^[a-z][a-zA-Z0-9]*$/.test(portName)) {
        usageError(
          `${where}: port name ${JSON.stringify(portName)} in stack "${stack.name}" is invalid.`,
          "Use a lower camel-case identifier such as `gotenberg` or `mailpitUi`.",
        );
      }
      if (portNames.has(portName)) {
        usageError(`${where}: duplicate port "${portName}" in stack "${stack.name}".`);
      }
      portNames.add(portName);
      if (
        typeof port.service !== "string" ||
        port.service.trim() === "" ||
        !Number.isInteger(port.containerPort) ||
        port.containerPort <= 0 ||
        port.containerPort > 65_535
      ) {
        usageError(
          `${where}: port "${stack.name}.${portName}" needs a service and a containerPort from 1 to 65535.`,
        );
      }
      if (
        port.protocol !== undefined &&
        port.protocol !== "tcp" &&
        port.protocol !== "udp"
      ) {
        usageError(
          `${where}: port "${stack.name}.${portName}" has invalid protocol ${JSON.stringify(port.protocol)}.`,
        );
      }
      if (
        port.probe !== undefined &&
        !["none", "tcp", "http", "postgres", "redis", "smtp"].includes(
          port.probe.kind,
        )
      ) {
        usageError(
          `${where}: port "${stack.name}.${portName}" has an invalid probe.`,
        );
      }
      if (
        port.hostPort !== undefined &&
        (!Number.isInteger(port.hostPort) ||
          port.hostPort <= 0 ||
          port.hostPort > 65_535)
      ) {
        usageError(`${where}: invalid hostPort for "${stack.name}.${portName}".`);
      }
    }
  }
}

function validateResource(
  name: string,
  resource: AnyResourceAdapter,
  stackNames: Set<string>,
  stacks: ComposeStackSpec[],
  where: string,
): void {
  if (
    !resource ||
    typeof resource !== "object" ||
    typeof resource.kind !== "string" ||
    typeof resource.isolation !== "string" ||
    typeof resource.resolve !== "function" ||
    !resource.endpoint ||
    typeof resource.endpoint.stack !== "string" ||
    typeof resource.endpoint.port !== "string"
  ) {
    usageError(
      `${where}: resource "${name}" is not a valid resource adapter.`,
      "Use a built-in helper such as postgresDatabase(), redisNamespace(), or s3Bucket(), or defineResourceAdapter().",
    );
  }
  if (!stackNames.has(resource.endpoint.stack)) {
    usageError(
      `${where}: resource "${name}" references unknown Compose stack "${resource.endpoint.stack}".`,
    );
  }
  const stack = stacks.find((entry) => entry.name === resource.endpoint.stack)!;
  const ports = new Set(Object.keys(stack.ports ?? {}));
  if (!ports.has(resource.endpoint.port)) {
    usageError(
      `${where}: resource "${name}" references undeclared port "${resource.endpoint.stack}.${resource.endpoint.port}".`,
    );
  }
}

function validateProcesses(config: WorkTrellisConfig, where: string): void {
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
      usageError(
        `${where}: process dependency cycle: ${[
          ...visiting.slice(cycleAt),
          name,
        ].join(" -> ")}.`,
      );
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
