/**
 * Exit codes are part of the CLI contract — CI and wrapper scripts branch on
 * them, so they must stay stable.
 */
export const EXIT = {
  ok: 0,
  /** A check failed: doctor found a problem, a conflict was detected. */
  checkFailed: 1,
  /** The user invoked the CLI incorrectly. */
  usage: 2,
  /** Something the environment must provide is missing (docker, node, git). */
  environment: 3,
  /** A resource is held by someone else: a port, a lease, a version clash. */
  conflict: 4,
  /** A supervised child process failed. */
  child: 5,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/**
 * An error that already knows how it should be presented. Anything thrown that
 * is NOT a WorkTrellisError is a bug, and the CLI prints its stack accordingly.
 */
export class WorkTrellisError extends Error {
  readonly code: ExitCode;
  /** Concrete next step. Printed under the message, indented. */
  readonly remediation?: string;

  constructor(
    message: string,
    options: { code?: ExitCode; remediation?: string; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "WorkTrellisError";
    this.code = options.code ?? EXIT.checkFailed;
    this.remediation = options.remediation;
  }
}

export function usageError(message: string, remediation?: string): never {
  throw new WorkTrellisError(message, { code: EXIT.usage, remediation });
}

export function environmentError(
  message: string,
  remediation?: string,
): never {
  throw new WorkTrellisError(message, { code: EXIT.environment, remediation });
}

export function conflictError(message: string, remediation?: string): never {
  throw new WorkTrellisError(message, { code: EXIT.conflict, remediation });
}
