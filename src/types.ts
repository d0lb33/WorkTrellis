/**
 * The WorkTrellis public contract.
 *
 * Everything a project needs to say about itself is expressed here and supplied
 * through its `worktrellis.config.ts`. Nothing in this package may import from a
 * host project; all project knowledge arrives through these types.
 */

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

export interface PostgresSpec {
  kind: "postgres";
  /** Major version. Governs the image tag AND the data volume identity. */
  version: string;
  image?: string;
  port?: number;
  superuser?: string;
  password?: string;
  /** Extra `-c key=value` server arguments, e.g. ["max_connections=300"]. */
  serverArgs?: string[];
}

export interface RedisSpec {
  kind: "redis";
  version: string;
  image?: string;
  port?: number;
}

export interface MinioSpec {
  kind: "minio";
  version?: string;
  image?: string;
  apiPort?: number;
  consolePort?: number;
  rootUser?: string;
  rootPassword?: string;
  region?: string;
}

export interface MailpitSpec {
  kind: "mailpit";
  version?: string;
  image?: string;
  smtpPort?: number;
  uiPort?: number;
}

export type ServiceSpec = PostgresSpec | RedisSpec | MinioSpec | MailpitSpec;
export type ServiceKind = ServiceSpec["kind"];

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
  /** `<label>-<fingerprint>`. A DNS label, and the isolation key for everything. */
  slug: string;
  /** 8 lowercase hex derived from `root`. The collision breaker. */
  fingerprint: string;
  databaseName: string;
  bucketName: string;
  redisPrefix: string;
  redisDb: number;
  /** Deterministic per-worktree ports, `app` plus anything in config.extraPorts. */
  ports: Readonly<Record<string, number>>;
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

export type UrlMode = "portless" | "direct";

export interface UrlContext {
  mode: UrlMode;
  /** Public URL of this worktree's app. */
  appUrl: string;
  /** Hostname only, no scheme or port. */
  rootDomain: string;
  /** Leading-dot cookie domain, or "" when subdomain cookies do not apply. */
  cookieDomain: string;
  /** e.g. "https://<subdomain>.<rootDomain>" — display and docs. */
  tenantUrlTemplate: string;
  /** ["<root>", "*.<root>", "*.*.<root>"] for dev-origin allowlists. */
  wildcardOrigins: string[];
  listenHost: string;
  /** The port the app process must actually bind. */
  listenPort: number;
  /** Provider-supplied extras, e.g. NODE_EXTRA_CA_CERTS. */
  providerEnv: Record<string, string>;
  /** Set when the preferred provider was unavailable; shown once to the user. */
  fallbackReason?: string;
}

// ---------------------------------------------------------------------------
// Resolved service endpoints
// ---------------------------------------------------------------------------

export interface PostgresEndpoint {
  host: string;
  port: number;
  user: string;
  password: string;
  urlFor(database: string): string;
}

export interface RedisEndpoint {
  host: string;
  port: number;
  urlFor(db: number): string;
}

export interface MinioEndpoint {
  endpoint: string;
  consoleUrl: string;
  accessKey: string;
  secretKey: string;
  region: string;
}

export interface MailpitEndpoint {
  smtpHost: string;
  smtpPort: number;
  uiUrl: string;
}

export interface PlatformEndpoints {
  postgres?: PostgresEndpoint;
  redis?: RedisEndpoint;
  minio?: MinioEndpoint;
  mailpit?: MailpitEndpoint;
}

// ---------------------------------------------------------------------------
// Env profile
// ---------------------------------------------------------------------------

export interface EnvContext {
  workspace: WorkspaceIdentity;
  services: PlatformEndpoints;
  url: UrlContext;
  /** Parsed base env file (secrets). READ ONLY — WorkTrellis never writes it. */
  baseEnv: Readonly<Record<string, string>>;
}

/**
 * Returns ONLY WorkTrellis-owned keys. A key mapped to `undefined` is omitted from
 * the generated snapshot entirely (never written as an empty value, which some
 * env loaders treat as "delete this variable").
 */
export type EnvProfile = (
  context: EnvContext,
) => Record<string, string | undefined>;

// ---------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------

/**
 * A command is always a real executable — never a shell string and never a
 * `.cmd`/`.bat` shim. `node` resolves the entry against the project root and
 * runs it with the current Node binary, which is what makes tree-kill reliable.
 */
export type Command =
  | { node: string[] }
  | { bin: string; args: string[] };

export interface ReadyCheck {
  port?: number;
  logMatch?: RegExp;
  timeoutMs?: number;
}

export interface ProcessSpec {
  name: string;
  command: Command | ((context: EnvContext) => Command);
  /** True for the process that must bind url.listenPort. */
  bindsAppPort?: boolean;
  env?: (context: EnvContext) => Record<string, string>;
  restart?: "never" | "on-crash";
  maxRestarts?: number;
  readyWhen?: ReadyCheck;
  dependsOn?: string[];
  color?: "blue" | "magenta" | "cyan" | "yellow" | "green";
}

// ---------------------------------------------------------------------------
// Database bootstrap
// ---------------------------------------------------------------------------

export interface BootstrapContext {
  workspace: WorkspaceIdentity;
  env: Readonly<Record<string, string>>;
  /** The database this call must target. */
  databaseUrl: string;
  exec(
    bin: string,
    args: string[],
    options?: { env?: Record<string, string> },
  ): Promise<void>;
  /** Resolve an executable's real entry point from the project's node_modules. */
  bin(name: string): string;
  sql<T = unknown>(text: string, params?: unknown[]): Promise<T[]>;
  log(message: string): void;
}

export interface BootstrapHooks {
  /** Files hashed into the template fingerprint; a change rebuilds the template. */
  schemaFingerprintFiles?: string[];
  /** Empty database -> fully migrated. */
  migrate?: (context: BootstrapContext) => Promise<void>;
  /** Post-migration DDL: triggers, LISTEN/NOTIFY installers, extensions. */
  install?: (context: BootstrapContext) => Promise<void>;
  seed?: (context: BootstrapContext) => Promise<void>;
  seeds?: Record<string, (context: BootstrapContext) => Promise<void>>;
  afterClone?: (
    context: BootstrapContext & { fromSlug: string },
  ) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Doctor
// ---------------------------------------------------------------------------

export interface DoctorResult {
  ok: boolean;
  label: string;
  detail?: string;
  fix?: string;
  severity?: "warn" | "fail";
}

export type DoctorCheck = (context: EnvContext) => Promise<DoctorResult>;

// ---------------------------------------------------------------------------
// Top-level config
// ---------------------------------------------------------------------------

export const WORKTRELLIS_CONFIG_VERSION = 1 as const;
export type WorkTrellisConfigVersion = typeof WORKTRELLIS_CONFIG_VERSION;

export interface WorkTrellisConfig {
  /**
   * Version of the configuration contract, independent from the npm package.
   * WorkTrellis refuses unknown versions instead of guessing at their meaning.
   */
  configVersion: WorkTrellisConfigVersion;
  /** DNS label. Namespaces databases, buckets, Redis keys, and hostnames. */
  project: string;
  services: ServiceSpec[];
  env: EnvProfile;
  processes: ProcessSpec[];
  db?: BootstrapHooks;
  /** Secrets file. Read only, always. Defaults to ".env". */
  baseEnvFile?: string;
  /** Keys whose conflict with the base env file fails `worktrellis doctor`. */
  criticalKeys?: string[];
  /** Additional deterministic per-worktree ports, by name. */
  extraPorts?: string[];
  url?: {
    provider?: "portless" | "direct" | "auto";
    wildcard?: boolean;
    basePort?: number;
  };
  gc?: { maxIdleDays?: number };
  doctor?: DoctorCheck[];
}

/** Identity helper that gives a project's config file full type inference. */
export function defineConfig(config: WorkTrellisConfig): WorkTrellisConfig {
  return config;
}
