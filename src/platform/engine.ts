import { environmentError } from "../core/errors";
import { readMachineConfig } from "../core/state";
import { run, whichSync } from "../util/proc";

export interface ContainerEngine {
  name: "docker" | "podman";
  /** Absolute path to the engine CLI. */
  cli: string;
  /** Full compose invocation, e.g. [dockerPath, "compose"]. */
  compose: string[];
}

export interface DockerContextInfo {
  name: string;
  endpoint: string;
  isRemote: boolean;
}

const CANDIDATES = [
  { name: "docker" as const, legacy: "docker-compose" },
  { name: "podman" as const, legacy: "podman-compose" },
];

let cached: ContainerEngine | null = null;

/** Locate a container engine plus a working Compose implementation. */
export async function detectEngine(): Promise<ContainerEngine> {
  if (cached) return cached;

  const preferred = readMachineConfig().engine;
  const ordered = preferred
    ? [...CANDIDATES].sort((a) => (a.name === preferred ? -1 : 1))
    : CANDIDATES;

  for (const candidate of ordered) {
    const cli = whichSync(candidate.name);
    if (!cli) continue;

    const builtIn = await run(cli, ["compose", "version"], {
      quiet: true,
      timeoutMs: 30_000,
    }).catch(() => null);

    if (builtIn?.code === 0) {
      cached = { name: candidate.name, cli, compose: [cli, "compose"] };
      return cached;
    }

    const legacy = whichSync(candidate.legacy);
    if (legacy) {
      cached = { name: candidate.name, cli, compose: [legacy] };
      return cached;
    }

    environmentError(
      `${candidate.name} is installed but Compose is not.`,
      `Install the Compose plugin, or install ${candidate.legacy}.`,
    );
  }

  return environmentError(
    "No container engine found.",
    "Install one of:\n  Docker      https://docs.docker.com/engine/install/\n  Podman      https://podman.io/getting-started/installation",
  );
}

/** Verify the daemon is reachable, not merely that the CLI is installed. */
export async function assertDaemonRunning(
  engine: ContainerEngine,
): Promise<void> {
  const result = await run(engine.cli, ["info", "--format", "{{.ServerVersion}}"], {
    quiet: true,
    timeoutMs: 60_000,
  });

  if (result.code !== 0) {
    const firstLine = result.stderr.trim().split("\n")[0] ?? "";
    environmentError(
      `The ${engine.name} daemon is not reachable.`,
      `Start ${engine.name} and try again.${firstLine ? `\n${firstLine}` : ""}`,
    );
  }
}

export async function engineVersion(engine: ContainerEngine): Promise<string> {
  const result = await run(engine.cli, ["version", "--format", "{{.Client.Version}}"], {
    quiet: true,
    timeoutMs: 30_000,
  });
  return result.code === 0 ? result.stdout.trim() : "unknown";
}

/**
 * The docker context in use. Worth surfacing: with a remote context, container
 * health and reachability-from-here are different questions, and a port that
 * looks free locally may be published on another host entirely.
 */
export async function engineContext(
  engine: ContainerEngine,
): Promise<DockerContextInfo | null> {
  if (engine.name !== "docker") return null;

  const result = await run(
    engine.cli,
    ["context", "inspect", "--format", "{{.Name}}\t{{.Endpoints.docker.Host}}"],
    { quiet: true, timeoutMs: 30_000 },
  );
  if (result.code !== 0) return null;

  const [name, endpoint] = result.stdout.trim().split("\t");
  if (!name || !endpoint) return null;

  const isRemote = /^(ssh|tcp):\/\//.test(endpoint);
  return { name, endpoint, isRemote };
}
