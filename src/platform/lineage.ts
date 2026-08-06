import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import type {
  ComposePortSpec,
  ComposeStackSpec,
  WorkspaceIdentity,
} from "../types";
import { conflictError, WorkTrellisError } from "../core/errors";
import { homePaths } from "../core/state";
import { withLock } from "../core/lock";
import { readJsonFile } from "../util/fs";
import { run } from "../util/proc";
import type { ContainerEngine } from "./engine";
import { ComposeStack } from "./compose";
import { renderStack, type RenderedStack } from "./compose-render";
import {
  clearVerifiedStaleLeases,
  consumersForProject,
  readLineageManifest,
  replaceProjectLineageSelection,
  selectedLineage,
  type LeaseConsumer,
} from "./lineage-state";

export interface MachineVariant {
  projectName: string;
  running: boolean;
  retained: boolean;
  volumes: string[];
  createdAt: string | null;
  compatibility: "current" | "different" | "unknown";
  selected: boolean;
  consumers: LeaseConsumer[];
  reconcileSafe?: boolean;
  reconcileReason?: string;
}

interface ContainerInventory {
  projectName: string;
  running: boolean;
}

export async function listMachineVariants(options: {
  engine: ContainerEngine;
  rendered: RenderedStack;
}): Promise<MachineVariant[]> {
  if (options.rendered.scope !== "machine") return [];
  const prefix = machinePrefix(options.rendered.name);
  const [containers, volumes] = await Promise.all([
    listComposeContainers(options.engine),
    listComposeVolumes(options.engine),
  ]);
  const projects = new Set<string>();
  for (const container of containers) {
    if (container.projectName.startsWith(prefix)) projects.add(container.projectName);
  }
  for (const [project] of volumes) {
    if (project.startsWith(prefix)) projects.add(project);
  }
  try {
    for (const entry of fs.readdirSync(homePaths.stacks())) {
      if (entry.startsWith(prefix)) projects.add(entry);
    }
  } catch {
    // No machine stack state yet.
  }

  const selected = selectedLineage(options.rendered.compatibilityId);
  return [...projects]
    .sort()
    .map((projectName) => {
      const projectContainers = containers.filter(
        (entry) => entry.projectName === projectName,
      );
      const projectVolumes = [...(volumes.get(projectName) ?? [])].sort();
      const manifest = readLineageManifest(projectName);
      const directory = homePaths.stack(projectName);
      let createdAt: string | null = null;
      try {
        createdAt = fs.statSync(directory).birthtime.toISOString();
      } catch {
        // Docker may know about a legacy project without WorkTrellis state.
      }
      return {
        projectName,
        running: projectContainers.some((entry) => entry.running),
        retained: projectContainers.length > 0 || projectVolumes.length > 0,
        volumes: projectVolumes,
        createdAt,
        compatibility:
          projectName === options.rendered.compatibilityId ||
          manifest?.compatibilityId === options.rendered.compatibilityId
            ? "current"
            : manifest || projectDefinitionExists(projectName)
              ? "different"
              : "unknown",
        selected:
          (selected?.projectName ?? options.rendered.stackId) === projectName,
        consumers: consumersForProject(projectName),
      } satisfies MachineVariant;
    });
}

export async function assessReconciliation(options: {
  engine: ContainerEngine;
  spec: ComposeStackSpec;
  projectRoot: string;
  identity: WorkspaceIdentity;
  baseEnv: Readonly<Record<string, string>>;
  sourceProject: string;
  bindAddress?: string;
}): Promise<{ safe: boolean; reason?: string }> {
  try {
    const natural = renderStack({
      spec: options.spec,
      projectRoot: options.projectRoot,
      identity: options.identity,
      baseEnv: options.baseEnv,
      bindAddress: options.bindAddress,
    });
    const ports = readStackPorts(options.sourceProject, natural.portSpecs);
    const desired = renderStack({
      spec: options.spec,
      projectRoot: options.projectRoot,
      identity: options.identity,
      baseEnv: options.baseEnv,
      bindAddress: options.bindAddress,
      physicalProjectName: options.sourceProject,
      physicalPorts: ports,
    });
    await assertReconciliationSafe(options.engine, desired);
    return { safe: true };
  } catch (caught) {
    return {
      safe: false,
      reason:
        caught instanceof Error ? caught.message : "compatibility could not be proven",
    };
  }
}

export function retainedConflicts(
  rendered: RenderedStack,
  variants: MachineVariant[],
): MachineVariant[] {
  const current = variants.find(
    (variant) => variant.projectName === rendered.stackId && variant.retained,
  );
  if (current) return [];
  return variants.filter(
    (variant) => variant.projectName !== rendered.stackId && variant.retained,
  );
}

export function readStackPorts(
  projectName: string,
  specs: Record<string, ComposePortSpec>,
): Record<string, number> {
  const override = readJsonFile<{
    services?: Record<string, { ports?: string[] }>;
  }>(path.join(homePaths.stack(projectName), "99-worktrellis-ports.compose.yml"));
  const result: Record<string, number> = {};
  for (const [name, spec] of Object.entries(specs)) {
    for (const publication of override?.services?.[spec.service]?.ports ?? []) {
      const match = /^(?:\[[^\]]+\]|[^:]+):(\d+):(\d+)\/(tcp|udp)$/.exec(
        publication,
      );
      if (
        match &&
        Number(match[2]) === spec.containerPort &&
        match[3] === (spec.protocol ?? "tcp")
      ) {
        result[name] = Number(match[1]);
      }
    }
  }
  if (Object.keys(result).length !== Object.keys(specs).length) {
    conflictError(
      `Cannot recover the published ports for ${projectName}.`,
      "The retained stack is missing a complete WorkTrellis port override.",
    );
  }
  return result;
}

export async function reconcileMachineLineage(options: {
  engine: ContainerEngine;
  spec: ComposeStackSpec;
  projectRoot: string;
  identity: WorkspaceIdentity;
  baseEnv: Readonly<Record<string, string>>;
  sourceProject: string;
  bindAddress?: string;
}): Promise<RenderedStack> {
  const desiredNatural = renderStack({
    spec: options.spec,
    projectRoot: options.projectRoot,
    identity: options.identity,
    baseEnv: options.baseEnv,
    bindAddress: options.bindAddress,
  });
  if (options.spec.scope !== "machine") {
    throw new WorkTrellisError("Only machine-scoped stacks can be reconciled.");
  }
  const prefix = machinePrefix(options.spec.name);
  if (
    !/^[a-z0-9][a-z0-9_-]*$/.test(options.sourceProject) ||
    !options.sourceProject.startsWith(prefix)
  ) {
    conflictError(
      `${options.sourceProject} is not a variant of machine stack "${options.spec.name}".`,
    );
  }
  const knownSource = (
    await listMachineVariants({
      engine: options.engine,
      rendered: desiredNatural,
    })
  ).some(
    (variant) =>
      variant.projectName === options.sourceProject && variant.retained,
  );
  if (!knownSource) {
    conflictError(`${options.sourceProject} has no retained containers or volumes.`);
  }

  const selectedProject = selectedLineage(
    desiredNatural.compatibilityId,
  )?.projectName;
  const boundProjects = new Set(
    [options.sourceProject, desiredNatural.stackId, selectedProject].filter(
      (project): project is string => Boolean(project),
    ),
  );
  for (const project of boundProjects) {
    clearVerifiedStaleLeases(project);
    const consumers = consumersForProject(project).filter(
      (consumer) => consumer.state !== "stale",
    );
    if (consumers.length > 0) {
      conflictError(
        `${project} is still in use.`,
        consumers
          .map(
            (consumer) =>
              `${consumer.project}/${consumer.slug} pid ${consumer.pid} (${consumer.state})`,
          )
          .join("\n"),
      );
    }
  }

  const ports = readStackPorts(
    options.sourceProject,
    desiredNatural.portSpecs,
  );
  const desired = renderStack({
    spec: options.spec,
    projectRoot: options.projectRoot,
    identity: options.identity,
    baseEnv: options.baseEnv,
    bindAddress: options.bindAddress,
    physicalProjectName: options.sourceProject,
    physicalPorts: ports,
  });

  await assertReconciliationSafe(options.engine, desired);

  return withLock(`lineage-${options.spec.name}`, async () => {
    clearVerifiedStaleLeases(options.sourceProject);
    const live = consumersForProject(options.sourceProject).filter(
      (consumer) => consumer.state !== "stale",
    );
    if (live.length > 0) {
      conflictError(`${options.sourceProject} became active during reconciliation.`);
    }

    const sourceDirectory = homePaths.stack(options.sourceProject);
    const backupDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "worktrellis-lineage-rollback-"),
    );
    fs.cpSync(sourceDirectory, backupDirectory, { recursive: true });
    const source = stackFromExisting(options.engine, desired, sourceDirectory);

    try {
      await source.down();
      const target = new ComposeStack(options.engine, desired);
      target.sync();
      await target.up();
      if (desiredNatural.stackId !== options.sourceProject) {
        const variants = await listMachineVariants({
          engine: options.engine,
          rendered: desiredNatural,
        });
        const existingTarget = variants.find(
          (variant) =>
            variant.projectName === desiredNatural.stackId && variant.running,
        );
        if (existingTarget) {
          await new ComposeStack(options.engine, desiredNatural).down();
        }
      }
      replaceProjectLineageSelection({
        compatibilityId: desired.compatibilityId,
        projectName: options.sourceProject,
        ports,
        selectedAt: new Date().toISOString(),
      });
      return desired;
    } catch (caught) {
      try {
        fs.rmSync(sourceDirectory, { recursive: true, force: true });
        fs.cpSync(backupDirectory, sourceDirectory, { recursive: true });
        await stackFromExisting(
          options.engine,
          desired,
          sourceDirectory,
        ).up();
      } catch (rollback) {
        throw new WorkTrellisError(
          `Reconciliation failed and ${options.sourceProject} could not be restarted. Its volumes were retained.`,
          { cause: rollback },
        );
      } finally {
        fs.rmSync(backupDirectory, { recursive: true, force: true });
      }
      throw caught;
    } finally {
      fs.rmSync(backupDirectory, { recursive: true, force: true });
    }
  });
}

async function assertReconciliationSafe(
  engine: ContainerEngine,
  desired: RenderedStack,
): Promise<void> {
  const sourceDirectory = homePaths.stack(desired.stackId);
  const sourceFiles = readJsonFile<string[]>(
    path.join(sourceDirectory, "files.json"),
  )?.map((name) => path.join(sourceDirectory, name));
  if (!sourceFiles?.length || sourceFiles.some((file) => !fs.existsSync(file))) {
    conflictError(`Cannot inspect retained definition ${desired.stackId}.`);
  }

  const candidateDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "worktrellis-lineage-candidate-"),
  );
  try {
    const candidateFiles = desired.files.map((file) => {
      const target = path.join(candidateDirectory, file.name);
      fs.writeFileSync(target, file.contents);
      return target;
    });
    const [sourceModel, desiredModel] = await Promise.all([
      composeModel(engine, desired.stackId, sourceDirectory, sourceFiles, desired.environment),
      composeModel(engine, desired.stackId, candidateDirectory, candidateFiles, desired.environment),
    ]);
    const sourceVersions =
      readLineageManifest(desired.stackId)?.volumeDataVersions ?? {};
    const targetVersions = desired.volumeDataVersions;

    await assertRuntimeMatchesStrictState(
      engine,
      desired.stackId,
      sourceModel,
      sourceVersions,
      targetVersions,
    );

    for (const [volume, version] of Object.entries(sourceVersions)) {
      if (targetVersions[volume] !== version) {
        conflictError(
          `Volume data version changed for ${volume}.`,
          "Start a fresh machine variant and use project-owned migration tooling.",
        );
      }
    }

    const differences = await statefulDifferences(
      engine,
      sourceModel,
      desiredModel,
    );
    const uncovered = differences.filter(
      (difference) =>
        difference.requiresStrictEquivalence ||
        difference.volumes.length === 0 ||
        difference.volumes.some(
          (volume) =>
            !sourceVersions[volume] ||
            sourceVersions[volume] !== targetVersions[volume],
        ),
    );
    if (uncovered.length > 0) {
      conflictError(
        `WorkTrellis cannot prove ${desired.stackId} is data-compatible.`,
        uncovered
          .map((entry) => `${entry.service}: ${entry.reason}`)
          .join("\n") +
          "\nUse a fresh variant, or declare matching volumeDataVersions after verifying compatibility.",
      );
    }
  } finally {
    fs.rmSync(candidateDirectory, { recursive: true, force: true });
  }
}

type ComposeModel = {
  services?: Record<
    string,
    {
      image?: string;
      command?: unknown;
      entrypoint?: unknown;
      environment?: Record<string, string | null>;
      volumes?: Array<{
        type?: string;
        source?: string;
        target?: string;
        read_only?: boolean;
      }>;
    }
  >;
  volumes?: Record<string, { external?: boolean; name?: string } | null>;
};

type RuntimeContainer = {
  Image?: string;
  Config?: {
    Cmd?: unknown;
    Entrypoint?: unknown;
    Env?: string[];
    Labels?: Record<string, string>;
  };
  Mounts?: Array<{
    Type?: string;
    Name?: string;
    Source?: string;
    Destination?: string;
    RW?: boolean;
  }>;
};

async function assertRuntimeMatchesStrictState(
  engine: ContainerEngine,
  projectName: string,
  source: ComposeModel,
  sourceVersions: Record<string, string>,
  targetVersions: Record<string, string>,
): Promise<void> {
  const stateful = Object.entries(source.services ?? {}).filter(
    ([, service]) => (service.volumes?.length ?? 0) > 0,
  );
  if (stateful.length === 0) return;

  const strictServices = stateful.filter(([, service]) =>
    (service.volumes ?? []).some((mount) => {
      if ((mount.type ?? "volume") !== "volume" || !mount.source) return true;
      if (source.volumes?.[mount.source]?.external) return true;
      return (
        !sourceVersions[mount.source] ||
        sourceVersions[mount.source] !== targetVersions[mount.source]
      );
    }),
  );
  if (strictServices.length === 0) return;

  const ids = await run(
    engine.cli,
    [
      "ps",
      "-a",
      "--filter",
      `label=com.docker.compose.project=${projectName}`,
      "--format",
      "{{.ID}}",
    ],
    { quiet: true, timeoutMs: 30_000 },
  );
  const containerIds = ids.stdout.split(/\r?\n/).filter(Boolean);
  if (ids.code !== 0 || containerIds.length === 0) {
    conflictError(
      `Cannot verify the retained stateful containers for ${projectName}.`,
      "A volume-only legacy lineage requires a fresh variant unless recorded volumeDataVersions authorize reuse.",
    );
  }
  const inspected = await run(engine.cli, ["inspect", ...containerIds], {
    quiet: true,
    timeoutMs: 30_000,
  });
  if (inspected.code !== 0) {
    conflictError(`Cannot inspect retained containers for ${projectName}.`);
  }
  const containers = JSON.parse(inspected.stdout) as RuntimeContainer[];
  const volumeNames = [
    ...new Set(
      containers.flatMap((container) =>
        (container.Mounts ?? [])
          .filter((mount) => mount.Type === "volume" && mount.Name)
          .map((mount) => mount.Name!),
      ),
    ),
  ];
  const composeVolumeNames = new Map<string, string>();
  if (volumeNames.length > 0) {
    const volumeInspection = await run(
      engine.cli,
      ["volume", "inspect", ...volumeNames],
      { quiet: true, timeoutMs: 30_000 },
    );
    if (volumeInspection.code === 0) {
      const definitions = JSON.parse(volumeInspection.stdout) as Array<{
        Name?: string;
        Labels?: Record<string, string>;
      }>;
      for (const definition of definitions) {
        const logical = definition.Labels?.["com.docker.compose.volume"];
        if (definition.Name && logical) {
          composeVolumeNames.set(definition.Name, logical);
        }
      }
    }
  }
  const byService = new Map(
    containers.map((container) => [
      container.Config?.Labels?.["com.docker.compose.service"] ?? "",
      container,
    ]),
  );

  for (const [name, configured] of strictServices) {
    const actual = byService.get(name);
    if (!actual) {
      conflictError(
        `Cannot verify stateful service ${name} in ${projectName}.`,
      );
    }
    const configuredEnvironment = configured.environment ?? {};
    const actualEnvironment = Object.fromEntries(
      (actual.Config?.Env ?? []).map((entry) => {
        const separator = entry.indexOf("=");
        return separator < 0
          ? [entry, ""]
          : [entry.slice(0, separator), entry.slice(separator + 1)];
      }),
    );
    if (
      Object.entries(configuredEnvironment).some(
        ([key, value]) => value !== null && actualEnvironment[key] !== value,
      )
    ) {
      conflictError(
        `Configured environment changed for stateful service ${name}.`,
      );
    }
    if (
      configured.command !== undefined &&
      configured.command !== null &&
      stable(configured.command) !== stable(actual.Config?.Cmd)
    ) {
      conflictError(`Command changed for stateful service ${name}.`);
    }
    if (
      configured.entrypoint !== undefined &&
      configured.entrypoint !== null &&
      stable(configured.entrypoint) !== stable(actual.Config?.Entrypoint)
    ) {
      conflictError(`Entrypoint changed for stateful service ${name}.`);
    }
    const desiredImageId = await resolveImageId(engine, configured.image);
    if (!desiredImageId || actual.Image !== desiredImageId) {
      conflictError(`Resolved image changed for stateful service ${name}.`);
    }
    const actualMounts = (actual.Mounts ?? []).map((mount) => ({
      type: mount.Type,
      source:
        mount.Type === "volume" && mount.Name
          ? composeVolumeNames.get(mount.Name) ?? mount.Name
          : mount.Type === "volume"
            ? mount.Name
            : mount.Source,
      target: mount.Destination,
      read_only: mount.RW === false,
    })).sort((left, right) =>
      String(left.target).localeCompare(String(right.target)),
    );
    const configuredMounts = (configured.volumes ?? []).map((mount) => ({
      type: mount.type ?? "volume",
      source: mount.source,
      target: mount.target,
      read_only: mount.read_only === true,
    })).sort((left, right) =>
      String(left.target).localeCompare(String(right.target)),
    );
    if (stable(actualMounts) !== stable(configuredMounts)) {
      conflictError(
        `Persistent mount topology changed for stateful service ${name}.`,
      );
    }
  }
}

async function composeModel(
  engine: ContainerEngine,
  projectName: string,
  directory: string,
  files: string[],
  environment: Record<string, string>,
): Promise<ComposeModel> {
  const cli = engine.compose[0];
  if (!cli) throw new WorkTrellisError("Compose command is not configured.");
  const result = await run(
    cli,
    [
      ...engine.compose.slice(1),
      "-p",
      projectName,
      "--project-directory",
      directory,
      ...files.flatMap((file) => ["-f", file]),
      "config",
      "--format",
      "json",
    ],
    { cwd: directory, env: { ...process.env, ...environment }, quiet: true, timeoutMs: 60_000 },
  );
  if (result.code !== 0) {
    throw new WorkTrellisError(`Compose could not render ${projectName}.`);
  }
  return JSON.parse(result.stdout) as ComposeModel;
}

async function statefulDifferences(
  engine: ContainerEngine,
  source: ComposeModel,
  desired: ComposeModel,
): Promise<
  Array<{
    service: string;
    reason: string;
    volumes: string[];
    requiresStrictEquivalence: boolean;
  }>
> {
  const differences: Array<{
    service: string;
    reason: string;
    volumes: string[];
    requiresStrictEquivalence: boolean;
  }> = [];
  const names = new Set([
    ...Object.keys(source.services ?? {}),
    ...Object.keys(desired.services ?? {}),
  ]);
  for (const name of names) {
    const before = source.services?.[name];
    const after = desired.services?.[name];
    const mounts = [...(before?.volumes ?? []), ...(after?.volumes ?? [])];
    if (mounts.length === 0) continue;
    const volumeNames = [
      ...new Set(
        mounts
          .filter((mount) => (mount.type ?? "volume") === "volume")
          .map((mount) => mount.source)
          .filter((value): value is string => Boolean(value)),
      ),
    ];
    const requiresStrictEquivalence = mounts.some((mount) => {
      if ((mount.type ?? "volume") !== "volume" || !mount.source) return true;
      return Boolean(
        source.volumes?.[mount.source]?.external ||
          desired.volumes?.[mount.source]?.external,
      );
    });
    if (!before || !after) {
      differences.push({
        service: name,
        reason: "stateful service was added or removed",
        volumes: volumeNames,
        requiresStrictEquivalence,
      });
      continue;
    }
    if (stable(before.volumes ?? []) !== stable(after.volumes ?? [])) {
      differences.push({
        service: name,
        reason: "persistent mount topology changed",
        volumes: volumeNames,
        requiresStrictEquivalence,
      });
      continue;
    }
    const [beforeImage, afterImage] = await Promise.all([
      resolveImageId(engine, before.image),
      resolveImageId(engine, after.image),
    ]);
    if (!beforeImage || !afterImage || beforeImage !== afterImage) {
      differences.push({
        service: name,
        reason: "resolved image changed",
        volumes: volumeNames,
        requiresStrictEquivalence,
      });
      continue;
    }
    if (
      stable(before.command) !== stable(after.command) ||
      stable(before.entrypoint) !== stable(after.entrypoint) ||
      stable(before.environment ?? {}) !== stable(after.environment ?? {})
    ) {
      differences.push({
        service: name,
        reason: "command, entrypoint, or configured environment changed",
        volumes: volumeNames,
        requiresStrictEquivalence,
      });
    }
  }
  return differences;
}

async function resolveImageId(
  engine: ContainerEngine,
  image: string | undefined,
): Promise<string | null> {
  if (!image) return null;
  let inspected = await run(engine.cli, ["image", "inspect", image, "--format", "{{.Id}}"], {
    quiet: true,
    timeoutMs: 60_000,
  });
  if (inspected.code !== 0) {
    const pulled = await run(engine.cli, ["pull", image], { quiet: true, timeoutMs: 300_000 });
    if (pulled.code !== 0) return null;
    inspected = await run(engine.cli, ["image", "inspect", image, "--format", "{{.Id}}"], {
      quiet: true,
      timeoutMs: 60_000,
    });
  }
  return inspected.code === 0 ? inspected.stdout.trim() : null;
}

function stackFromExisting(
  engine: ContainerEngine,
  desired: RenderedStack,
  directory: string,
): ComposeStack {
  const names =
    readJsonFile<string[]>(path.join(directory, "files.json")) ??
    desired.files.map((file) => file.name);
  const rendered: RenderedStack = {
    ...desired,
    files: names.map((name) => ({
      name,
      contents: fs.readFileSync(path.join(directory, name), "utf8"),
    })),
  };
  return new ComposeStack(engine, rendered);
}

async function listComposeContainers(
  engine: ContainerEngine,
): Promise<ContainerInventory[]> {
  const result = await run(
    engine.cli,
    [
      "ps",
      "-a",
      "--format",
      '{{.Label "com.docker.compose.project"}}\t{{.State}}',
    ],
    { quiet: true, timeoutMs: 30_000 },
  ).catch(() => null);
  if (!result || result.code !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim().split("\t"))
    .filter(([project]) => Boolean(project))
    .map(([projectName, state]) => ({
      projectName: projectName!,
      running: state === "running",
    }));
}

async function listComposeVolumes(
  engine: ContainerEngine,
): Promise<Map<string, Set<string>>> {
  const result = await run(
    engine.cli,
    [
      "volume",
      "ls",
      "--format",
      '{{.Name}}\t{{.Label "com.docker.compose.project"}}',
    ],
    { quiet: true, timeoutMs: 30_000 },
  ).catch(() => null);
  const volumes = new Map<string, Set<string>>();
  if (!result || result.code !== 0) return volumes;
  for (const line of result.stdout.split(/\r?\n/)) {
    const [name, project] = line.trim().split("\t");
    if (!name || !project) continue;
    const entries = volumes.get(project) ?? new Set<string>();
    entries.add(name);
    volumes.set(project, entries);
  }
  return volumes;
}

function machinePrefix(name: string): string {
  return `worktrellis-machine-${name}-`;
}

function projectDefinitionExists(projectName: string): boolean {
  const directory = homePaths.stack(projectName);
  return Boolean(
    readJsonFile<string[]>(path.join(directory, "files.json"))?.some(
      (name) => name !== "99-worktrellis-ports.compose.yml",
    ),
  );
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
