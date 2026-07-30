/**
 * Public entry point. A project's `worktrellis.config.ts` imports from here and
 * nothing else.
 */

export { defineConfig, WORKTRELLIS_CONFIG_VERSION } from "./types";

export type {
  BootstrapContext,
  BootstrapHooks,
  Command,
  DoctorCheck,
  DoctorResult,
  EnvContext,
  EnvProfile,
  MailpitEndpoint,
  MailpitSpec,
  MinioEndpoint,
  MinioSpec,
  PlatformEndpoints,
  PostgresEndpoint,
  PostgresSpec,
  ProcessSpec,
  ReadyCheck,
  RedisEndpoint,
  RedisSpec,
  ServiceKind,
  ServiceSpec,
  UrlContext,
  UrlMode,
  WorkspaceIdentity,
  WorkTrellisConfig,
  WorkTrellisConfigVersion,
} from "./types";
