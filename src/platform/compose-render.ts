import fs from "node:fs";
import path from "node:path";

import type {
  ComposePortSpec,
  ComposeStackSpec,
  WorkspaceIdentity,
} from "../types";
import { WorkTrellisError } from "../core/errors";
import { homePaths, readMachineConfig } from "../core/state";
import { sha256, hexModulo } from "../util/hash";

export interface RenderedComposeFile {
  name: string;
  contents: string;
}

export interface RenderedStack {
  /** Actual Compose project name holding containers and volumes. */
  stackId: string;
  /** Hash-derived identity of the desired project definition. */
  compatibilityId: string;
  definitionHash: string;
  volumeDataVersions: Record<string, string>;
  name: string;
  scope: ComposeStackSpec["scope"];
  files: RenderedComposeFile[];
  ports: Record<string, number>;
  portSpecs: Record<string, ComposePortSpec>;
  /** Resolved project inputs only; excludes generated port variables. */
  composeEnvironment: Record<string, string>;
  environment: Record<string, string>;
  projectDirectory: string;
  specHash: string;
}

export function effectivePortSpecs(
  spec: ComposeStackSpec,
): Record<string, ComposePortSpec> {
  return { ...(spec.ports ?? {}) };
}

export function renderStack(options: {
  spec: ComposeStackSpec;
  projectRoot: string;
  identity: WorkspaceIdentity;
  baseEnv?: Readonly<Record<string, string>>;
  /** Selected physical lineage for a machine stack. */
  physicalProjectName?: string;
  /** Existing lineage ports retained during reconciliation. */
  physicalPorts?: Readonly<Record<string, number>>;
}): RenderedStack {
  const { spec, projectRoot, identity } = options;
  const portSpecs = effectivePortSpecs(spec);
  const definitionFiles: RenderedComposeFile[] = [];
  const composeEnv = resolveComposeEnv(spec, options.baseEnv ?? {});

  for (const [index, configuredPath] of (spec.files ?? []).entries()) {
    const absolute = path.resolve(projectRoot, configuredPath);
    if (!fs.existsSync(absolute)) {
      throw new WorkTrellisError(
        `Compose file not found for stack "${spec.name}": ${configuredPath}`,
      );
    }
    definitionFiles.push({
      name: `${String(index).padStart(2, "0")}-project.compose.yml`,
      contents: fs.readFileSync(absolute, "utf8"),
    });
  }

  const definitionHash = sha256(
    stableStringify({
      files: definitionFiles.map((file) => file.contents),
      ports: portSpecs,
      env: composeEnv,
      ...(Object.keys(spec.volumeDataVersions ?? {}).length > 0
        ? { volumeDataVersions: spec.volumeDataVersions }
        : {}),
    }),
  );
  const compatibilityId = stackIdFor(spec, identity, definitionHash);
  const stackId = options.physicalProjectName ?? compatibilityId;
  const ports = options.physicalPorts
    ? { ...options.physicalPorts }
    : resolveHostPorts(spec, identity, stackId, portSpecs);
  const projectDirectory =
    spec.scope === "workspace" ? projectRoot : homePaths.stack(stackId);
  const environment = {
    ...composeEnv,
    ...Object.fromEntries(
      Object.entries(ports).map(([name, port]) => [
        `WORKTRELLIS_PORT_${constantName(name)}`,
        String(port),
      ]),
    ),
  };

  const files = [
    ...definitionFiles,
    {
      name: "99-worktrellis-ports.compose.yml",
      contents: renderPortOverride(portSpecs, ports),
    },
  ];
  const specHash = sha256(
    stableStringify({
      stackId,
      files,
      environment,
      projectDirectory,
    }),
  ).slice(0, 16);

  return {
    stackId,
    compatibilityId,
    definitionHash,
    volumeDataVersions: { ...(spec.volumeDataVersions ?? {}) },
    name: spec.name,
    scope: spec.scope,
    files,
    ports,
    portSpecs,
    composeEnvironment: composeEnv,
    environment,
    projectDirectory,
    specHash,
  };
}

function resolveComposeEnv(
  spec: ComposeStackSpec,
  baseEnv: Readonly<Record<string, string>>,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [name, value] of Object.entries(spec.env ?? {})) {
    const result =
      typeof value === "function" ? value({ baseEnv }) : value;
    if (result !== undefined) resolved[name] = result;
  }
  return resolved;
}

function stackIdFor(
  spec: ComposeStackSpec,
  identity: WorkspaceIdentity,
  definitionHash: string,
): string {
  const raw =
    spec.scope === "machine"
      ? `worktrellis-machine-${spec.name}-${definitionHash.slice(0, 8)}`
      : spec.scope === "repository"
        ? `worktrellis-repo-${identity.repoKey}-${spec.name}`
        : `worktrellis-${identity.project}-${identity.slug}-${spec.name}`;
  return compactName(raw);
}

function resolveHostPorts(
  stack: ComposeStackSpec,
  identity: WorkspaceIdentity,
  stackId: string,
  specs: Record<string, ComposePortSpec>,
): Record<string, number> {
  const overrides = readMachineConfig().portOverrides ?? {};
  const ports: Record<string, number> = {};

  for (const [name, spec] of Object.entries(specs)) {
    const scopedOverride = overrides[`${stack.name}.${name}`];
    const unqualifiedOverride = overrides[name];
    const explicit = spec.hostPort;

    if (scopedOverride ?? unqualifiedOverride ?? explicit) {
      ports[name] = scopedOverride ?? unqualifiedOverride ?? explicit!;
      continue;
    }

    const scopeKey =
      stack.scope === "machine"
        ? "machine"
        : stack.scope === "repository"
          ? identity.repoKey
          : `${identity.repoKey}:${identity.slug}`;
    const seed = sha256(`${scopeKey}:${stackId}:${name}`);
    ports[name] = 12_000 + hexModulo(seed, 40_000);
  }

  const byPort = new Map<number, string>();
  for (const [name, port] of Object.entries(ports)) {
    const existing = byPort.get(port);
    if (existing) {
      throw new WorkTrellisError(
        `Compose stack "${stack.name}" assigns host port ${port} to both "${existing}" and "${name}".`,
        {
          remediation:
            "Choose distinct hostPort values or remove the conflicting machine port override.",
        },
      );
    }
    byPort.set(port, name);
  }

  return ports;
}

function renderPortOverride(
  specs: Record<string, ComposePortSpec>,
  ports: Record<string, number>,
): string {
  const services: Record<string, { ports: string[] }> = {};
  for (const [name, spec] of Object.entries(specs)) {
    const service = services[spec.service] ?? { ports: [] };
    service.ports.push(
      `127.0.0.1:${ports[name]}:${spec.containerPort}/${spec.protocol ?? "tcp"}`,
    );
    services[spec.service] = service;
  }

  return `${JSON.stringify({ services }, null, 2)}\n`;
}

function constantName(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .toUpperCase();
}

function compactName(value: string): string {
  if (value.length <= 63) return value;
  const suffix = sha256(value).slice(0, 8);
  return `${value.slice(0, 54).replace(/-+$/, "")}-${suffix}`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, child]) =>
          `${JSON.stringify(key)}:${stableStringify(child)}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
