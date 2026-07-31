import { spawnSync } from "node:child_process";

export interface RealDockerReadiness {
  ready: boolean;
  reason?: string;
}

function commandFailure(
  command: string,
  args: string[],
  unavailable: string,
): string | null {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 60_000,
  });

  if (result.status === 0) return null;

  const detail = [result.error?.message, result.stderr, result.stdout]
    .find((value) => value?.trim())
    ?.trim()
    .split(/\r?\n/)[0];
  return detail ? `${unavailable}: ${detail}` : unavailable;
}

/**
 * Real-container tests are opt-in and should be portable across developer
 * machines. Missing external tooling is an explicit skip, while failures after
 * these prerequisites pass remain real test failures.
 */
export function realDockerReadiness(options: {
  requireGit?: boolean;
} = {}): RealDockerReadiness {
  if (process.env.WORKTRELLIS_COMPOSE_TEST !== "1") {
    return {
      ready: false,
      reason: "set WORKTRELLIS_COMPOSE_TEST=1 to run real Docker tests",
    };
  }

  const checks: Array<[string, string[], string]> = [];
  if (options.requireGit) {
    checks.push(["git", ["--version"], "Git is not available"]);
  }
  checks.push(
    ["docker", ["--version"], "Docker is not available"],
    ["docker", ["compose", "version"], "Docker Compose is not available"],
    [
      "docker",
      ["info", "--format", "{{.ServerVersion}}"],
      "the Docker daemon is not reachable",
    ],
  );

  for (const [command, args, unavailable] of checks) {
    const reason = commandFailure(command, args, unavailable);
    if (reason) return { ready: false, reason };
  }

  return { ready: true };
}
