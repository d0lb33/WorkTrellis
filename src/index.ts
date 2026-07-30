/** Public entry point used by `worktrellis.config.ts`. */

export { defineConfig, WORKTRELLIS_CONFIG_VERSION } from "./types";
export {
  defineResourceAdapter,
  postgresDatabase,
  redisNamespace,
  s3Bucket,
} from "./resources";

export type {
  AnyResourceAdapter,
  BootstrapContext,
  BootstrapHooks,
  Command,
  ComposeContext,
  ComposeEnvContext,
  ComposeEnvValue,
  ComposePortSpec,
  ComposeStackSpec,
  DoctorCheck,
  DoctorResult,
  EnvContext,
  EnvProfile,
  InfrastructureScope,
  PortProbe,
  PostgresDatabase,
  ProcessSpec,
  ReadyCheck,
  RedisNamespace,
  ResolvedComposeStack,
  ResolvedResourceEndpoint,
  ResolvedResources,
  ResourceAdapter,
  ResourceAdapters,
  ResourceEndpoint,
  ResourceProvisionContext,
  ResourceResolveContext,
  S3Bucket,
  UrlContext,
  UrlMode,
  WorkspaceIdentity,
  WorkTrellisConfig,
  WorkTrellisConfigVersion,
} from "./types";
export type {
  PostgresDatabaseOptions,
  RedisNamespaceOptions,
  ResourceString,
  S3BucketOptions,
} from "./resources";
