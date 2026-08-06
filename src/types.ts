/**
 * The WorkTrellis public contract.
 *
 * Projects own every Compose service definition. WorkTrellis owns stable
 * worktree identity, scoped Compose project names, host-port publication,
 * optional logical resource isolation, generated environment, and foreground
 * development processes.
 */

// ---------------------------------------------------------------------------
// Workspace identity
// ---------------------------------------------------------------------------

export interface WorkspaceIdentity {
  /** This worktree's absolute, realpath-resolved root. */
  root: string;
  /** Stable across every worktree of the same repository. */
  repoKey: string;
  isLinkedWorktree: boolean;
  /** null when HEAD is detached. */
  branch: string | null;
  head: string;
  /** From config.project — a DNS label. */
  project: string;
  /** `<label>-<fingerprint>`, and the isolation key for this worktree. */
  slug: string;
  /** Eight lowercase hex characters derived from the canonical worktree path. */
  fingerprint: string;
  /** Deterministic per-worktree process ports, always including `app`. */
  ports: Readonly<Record<string, number>>;
}

// ---------------------------------------------------------------------------
// Compose infrastructure
// ---------------------------------------------------------------------------

export type InfrastructureScope = "machine" | "repository" | "workspace";

export type PortProbe =
  | { kind: "none" }
  | { kind: "tcp" }
  | { kind: "postgres" }
  | { kind: "redis" }
  | { kind: "smtp" }
  | { kind: "http"; path?: string };

export interface ComposePortSpec {
  /** Service name in the merged Compose model. */
  service: string;
  /** Port listened to inside the service container. */
  containerPort: number;
  /** Optional fixed host port. Otherwise WorkTrellis derives one by scope. */
  hostPort?: number;
  protocol?: "tcp" | "udp";
  /** Reachability check. Defaults to TCP, or none for UDP. */
  probe?: PortProbe;
}

export interface ComposeEnvContext {
  /** Parsed project secrets file. Read only. */
  baseEnv: Readonly<Record<string, string>>;
}

export type ComposeEnvValue =
  | string
  | ((context: ComposeEnvContext) => string | undefined);

export interface ComposeStackSpec {
  /** Unique name within this WorkTrellis configuration. */
  name: string;
  /**
   * machine: shared by compatible projects on this host
   * repository: shared by all worktrees of this repository
   * workspace: one Compose project per worktree
   */
  scope: InfrastructureScope;
  /** Project-owned Compose files, relative to the configuration root. */
  files: string[];
  /**
   * Named host ports. WorkTrellis emits a final Compose override so projects do
   * not publish these ports themselves.
   */
  ports?: Record<string, ComposePortSpec>;
  /** Explicit interpolation values supplied only to Compose. */
  env?: Record<string, ComposeEnvValue>;
  /**
   * Opaque project-owned data-format generations, keyed by named Compose
   * volume. Equal values explicitly authorize in-place reuse when WorkTrellis
   * cannot otherwise prove a stateful definition is equivalent.
   */
  volumeDataVersions?: Record<string, string>;
}

export interface ResolvedComposeStack {
  name: string;
  scope: InfrastructureScope;
  /** Hash-derived identity of the desired Compose definition. */
  compatibilityId: string;
  /** Actual Compose project holding this stack's containers and volumes. */
  projectName: string;
  ports: Readonly<Record<string, number>>;
}

export interface ComposeContext {
  /** Hostname or address where declared ports are reachable from this machine. */
  host: string;
  stacks: Readonly<Record<string, ResolvedComposeStack>>;
  /** URL for a declared named port. HTTP is the default scheme. */
  url(stack: string, port: string, scheme?: string): string;
}

// ---------------------------------------------------------------------------
// Extensible resource adapters
// ---------------------------------------------------------------------------

export interface ResourceEndpoint {
  /** Compose stack name. */
  stack: string;
  /** Named port declared by that stack. */
  port: string;
}

export interface ResolvedResourceEndpoint extends ResourceEndpoint {
  host: string;
  hostPort: number;
  url(scheme?: string): string;
}

export interface ResourceResolveContext {
  workspace: WorkspaceIdentity;
  compose: ComposeContext;
  endpoint: ResolvedResourceEndpoint;
  /** Parsed project secrets file. Read only. */
  baseEnv: Readonly<Record<string, string>>;
}

export interface ResourceProvisionContext extends ResourceResolveContext {
  projectRoot: string;
}

/**
 * A resource adapter isolates logical data inside a protocol-compatible
 * endpoint. Third-party adapters can use this interface without teaching
 * WorkTrellis anything about the container image behind that endpoint.
 */
export interface ResourceAdapter<TResolved> {
  readonly kind: string;
  readonly isolation: string;
  readonly endpoint: ResourceEndpoint;
  resolve(context: ResourceResolveContext): TResolved;
  /** Short non-secret description used by status output. */
  describe?(resource: TResolved): string;
  provision?(
    resource: TResolved,
    context: ResourceProvisionContext,
  ): Promise<void>;
}

export type AnyResourceAdapter = ResourceAdapter<any>;
export type ResourceAdapters = Record<string, AnyResourceAdapter>;
export type ResolvedResources<
  TAdapters extends ResourceAdapters = ResourceAdapters,
> = {
  [K in keyof TAdapters]: TAdapters[K] extends ResourceAdapter<infer TResolved>
    ? TResolved
    : never;
};

export interface PostgresDatabase {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  url: string;
}

export interface RedisNamespace {
  host: string;
  port: number;
  database: number;
  prefix: string;
  url: string;
}

export interface S3Bucket {
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  region: string;
}

// ---------------------------------------------------------------------------
// URLs and generated environment
// ---------------------------------------------------------------------------

export type UrlMode = "portless" | "direct";

export interface UrlContext {
  mode: UrlMode;
  appUrl: string;
  rootDomain: string;
  cookieDomain: string;
  tenantUrlTemplate: string;
  wildcardOrigins: string[];
  listenHost: string;
  listenPort: number;
  providerEnv: Record<string, string>;
  /** Provider-returned private/public sharing URL for the live run, if any. */
  sharingUrl?: string;
  fallbackReason?: string;
}

export interface EnvContext<
  TAdapters extends ResourceAdapters = ResourceAdapters,
> {
  workspace: WorkspaceIdentity;
  compose: ComposeContext;
  resources: ResolvedResources<TAdapters>;
  url: UrlContext;
  /** Parsed base env file (secrets). READ ONLY — WorkTrellis never writes it. */
  baseEnv: Readonly<Record<string, string>>;
}

export type EnvProfile<
  TAdapters extends ResourceAdapters = ResourceAdapters,
> = (
  context: EnvContext<TAdapters>,
) => Record<string, string | undefined>;

// ---------------------------------------------------------------------------
// Foreground development processes
// ---------------------------------------------------------------------------

export type Command =
  | { node: string[] }
  | { bin: string; args: string[] };

export interface ReadyCheck {
  port?: number;
  logMatch?: RegExp;
  timeoutMs?: number;
}

export interface ProcessSpec<
  TAdapters extends ResourceAdapters = ResourceAdapters,
> {
  name: string;
  command: Command | ((context: EnvContext<TAdapters>) => Command);
  bindsAppPort?: boolean;
  env?: (context: EnvContext<TAdapters>) => Record<string, string>;
  restart?: "never" | "on-crash";
  maxRestarts?: number;
  readyWhen?: ReadyCheck;
  dependsOn?: string[];
  color?: "blue" | "magenta" | "cyan" | "yellow" | "green";
}

// ---------------------------------------------------------------------------
// Project-owned database bootstrap hooks
// ---------------------------------------------------------------------------

export interface BootstrapContext {
  workspace: WorkspaceIdentity;
  env: Readonly<Record<string, string>>;
  databaseUrl: string;
  exec(
    bin: string,
    args: string[],
    options?: { env?: Record<string, string> },
  ): Promise<void>;
  bin(name: string): string;
  sql<T = unknown>(text: string, params?: unknown[]): Promise<T[]>;
  log(message: string): void;
}

export interface BootstrapHooks {
  /** Name of the resolved PostgreSQL resource used by these hooks. */
  resource: string;
  schemaFingerprintFiles?: string[];
  migrate?: (context: BootstrapContext) => Promise<void>;
  install?: (context: BootstrapContext) => Promise<void>;
  seed?: (context: BootstrapContext) => Promise<void>;
  seeds?: Record<string, (context: BootstrapContext) => Promise<void>>;
  afterClone?: (
    context: BootstrapContext & { fromSlug: string },
  ) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Diagnostics and top-level config
// ---------------------------------------------------------------------------

export interface DoctorResult {
  ok: boolean;
  label: string;
  detail?: string;
  fix?: string;
  severity?: "warn" | "fail";
}

export type DoctorCheck<
  TAdapters extends ResourceAdapters = ResourceAdapters,
> = (context: EnvContext<TAdapters>) => Promise<DoctorResult>;

export const WORKTRELLIS_CONFIG_VERSION = 3 as const;
export type WorkTrellisConfigVersion = typeof WORKTRELLIS_CONFIG_VERSION;

export interface WorkTrellisConfig<
  TAdapters extends ResourceAdapters = ResourceAdapters,
> {
  configVersion: WorkTrellisConfigVersion;
  /** DNS label used to namespace worktrees and scoped infrastructure. */
  project: string;
  compose: ComposeStackSpec[];
  resources?: TAdapters;
  env: EnvProfile<TAdapters>;
  processes: ProcessSpec<TAdapters>[];
  db?: BootstrapHooks;
  baseEnvFile?: string;
  criticalKeys?: string[];
  /** Additional deterministic ports for foreground project processes. */
  processPorts?: string[];
  url?: {
    provider?: "portless" | "direct" | "auto";
    wildcard?: boolean;
    basePort?: number;
  };
  gc?: { maxIdleDays?: number };
  doctor?: DoctorCheck<TAdapters>[];
}

export function defineConfig<
  const TAdapters extends ResourceAdapters = Record<string, never>,
>(
  config: WorkTrellisConfig<TAdapters>,
): WorkTrellisConfig<TAdapters> {
  return config;
}
