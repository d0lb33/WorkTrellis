import type {
  AnyResourceAdapter,
  ComposeContext,
  PostgresDatabase,
  RedisNamespace,
  ResolvedResourceEndpoint,
  ResolvedResources,
  ResourceAdapter,
  ResourceAdapters,
  ResourceEndpoint,
  ResourceResolveContext,
  S3Bucket,
  WorkspaceIdentity,
} from "../types";
import { WorkTrellisError } from "../core/errors";
import {
  buildBucketName,
  buildDatabaseName,
  buildRedisPrefix,
} from "../core/naming";
import { hexModulo } from "../util/hash";
import { step } from "../util/log";
import { createDatabase, databaseExists } from "./postgres";

export type ResourceString = string | ((
  context: ResourceResolveContext,
) => string | undefined);

export interface PostgresDatabaseOptions {
  endpoint: ResourceEndpoint;
  isolation: "database";
  user?: ResourceString;
  password?: ResourceString;
}

export interface RedisNamespaceOptions {
  endpoint: ResourceEndpoint;
  isolation: "namespace";
  /** Number of logical databases exposed by the server. Defaults to 16. */
  databaseCount?: number;
}

export interface S3BucketOptions {
  endpoint: ResourceEndpoint;
  isolation: "bucket";
  accessKey?: ResourceString;
  secretKey?: ResourceString;
  region?: ResourceString;
  /** Use HTTPS when the endpoint is terminated locally. */
  secure?: boolean;
}

/**
 * Preserve a custom adapter's resolved type while making its intent explicit
 * in configuration. Containers remain completely outside this contract.
 */
export function defineResourceAdapter<TResolved>(
  adapter: ResourceAdapter<TResolved>,
): ResourceAdapter<TResolved> {
  return adapter;
}

export function postgresDatabase(
  options: PostgresDatabaseOptions,
): ResourceAdapter<PostgresDatabase> {
  return defineResourceAdapter({
    kind: "postgres-database",
    isolation: options.isolation,
    endpoint: options.endpoint,
    resolve(context) {
      const { workspace, endpoint } = context;
      const user = resolveString(options.user, context, "postgres");
      const password = resolveString(options.password, context, "postgres");
      const database = buildDatabaseName(workspace.project, workspace.slug);
      return {
        host: endpoint.host,
        port: endpoint.hostPort,
        user,
        password,
        database,
        url: postgresUrl({
          host: endpoint.host,
          port: endpoint.hostPort,
          user,
          password,
          database,
        }),
      };
    },
    describe: (resource) => `database ${resource.database}`,
    async provision(resource) {
      if (!(await databaseExists(resource.url, resource.database))) {
        step("database", `creating ${resource.database}`);
        await createDatabase(resource.url, resource.database);
      }
    },
  });
}

export function redisNamespace(
  options: RedisNamespaceOptions,
): ResourceAdapter<RedisNamespace> {
  if (
    options.databaseCount !== undefined &&
    (!Number.isInteger(options.databaseCount) || options.databaseCount <= 0)
  ) {
    throw new WorkTrellisError(
      "redisNamespace() databaseCount must be a positive integer.",
    );
  }
  return defineResourceAdapter({
    kind: "redis-namespace",
    isolation: options.isolation,
    endpoint: options.endpoint,
    resolve({ workspace, endpoint }) {
      const database = hexModulo(
        workspace.fingerprint,
        options.databaseCount ?? 16,
      );
      return {
        host: endpoint.host,
        port: endpoint.hostPort,
        database,
        prefix: buildRedisPrefix(workspace.project, workspace.slug),
        url: `redis://${endpoint.host}:${endpoint.hostPort}/${database}`,
      };
    },
    describe: (resource) =>
      `database ${resource.database}, prefix ${resource.prefix}`,
  });
}

export function s3Bucket(
  options: S3BucketOptions,
): ResourceAdapter<S3Bucket> {
  return defineResourceAdapter({
    kind: "s3-bucket",
    isolation: options.isolation,
    endpoint: options.endpoint,
    resolve(context) {
      const { workspace, endpoint } = context;
      return {
        endpoint: endpoint.url(options.secure ? "https" : "http"),
        bucket: buildBucketName(workspace.project, workspace.slug),
        accessKey: resolveString(options.accessKey, context, "minioadmin"),
        secretKey: resolveString(options.secretKey, context, "minioadmin"),
        region: resolveString(options.region, context, "us-east-1"),
      };
    },
    describe: (resource) => `bucket ${resource.bucket}`,
    provision: ensureObjectStorageBucket,
  });
}

export function resolveResources<
  TAdapters extends ResourceAdapters,
>(options: {
  adapters?: TAdapters;
  compose: ComposeContext;
  identity: WorkspaceIdentity;
  baseEnv?: Readonly<Record<string, string>>;
  host?: string;
}): ResolvedResources<TAdapters> {
  const adapters = options.adapters ?? ({} as TAdapters);
  const resources: Record<string, unknown> = {};

  for (const [name, adapter] of Object.entries(adapters)) {
    const endpoint = resolveEndpoint(
      options.compose,
      adapter.endpoint,
      options.host,
    );
    resources[name] = adapter.resolve({
      workspace: options.identity,
      compose: options.compose,
      endpoint,
      baseEnv: options.baseEnv ?? {},
    });
  }

  return resources as ResolvedResources<TAdapters>;
}

export async function provisionResources(options: {
  adapters?: ResourceAdapters;
  resources: Record<string, unknown>;
  compose: ComposeContext;
  identity: WorkspaceIdentity;
  projectRoot: string;
  baseEnv?: Readonly<Record<string, string>>;
  skip?: string[];
  host?: string;
}): Promise<void> {
  const skipped = new Set(options.skip ?? []);
  for (const [name, adapter] of Object.entries(options.adapters ?? {})) {
    if (!adapter.provision || skipped.has(name)) continue;
    const endpoint = resolveEndpoint(
      options.compose,
      adapter.endpoint,
      options.host,
    );
    await provisionOne(adapter, options.resources[name], {
      workspace: options.identity,
      compose: options.compose,
      endpoint,
      projectRoot: options.projectRoot,
      baseEnv: options.baseEnv ?? {},
    });
  }
}

export function describeResources(
  adapters: ResourceAdapters | undefined,
  resources: Record<string, unknown>,
): Array<{ name: string; kind: string; detail: string }> {
  return Object.entries(adapters ?? {}).map(([name, adapter]) => {
    const value = resources[name];
    return {
      name,
      kind: adapter.kind,
      detail:
        value === undefined
          ? `${adapter.isolation} (unresolved)`
          : (adapter.describe?.(value) ?? adapter.isolation),
    };
  });
}

async function provisionOne(
  adapter: AnyResourceAdapter,
  value: unknown,
  context: Parameters<NonNullable<AnyResourceAdapter["provision"]>>[1],
): Promise<void> {
  if (value === undefined) {
    throw new WorkTrellisError(
      `Resource adapter "${adapter.kind}" resolved no value before provisioning.`,
    );
  }
  await adapter.provision?.(value, context);
}

async function ensureObjectStorageBucket(resource: S3Bucket): Promise<void> {
  const {
    CreateBucketCommand,
    HeadBucketCommand,
    S3Client,
  } = await import("@aws-sdk/client-s3");
  const client = new S3Client({
    endpoint: resource.endpoint,
    region: resource.region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: resource.accessKey,
      secretAccessKey: resource.secretKey,
    },
  });

  try {
    await client.send(new HeadBucketCommand({ Bucket: resource.bucket }));
    return;
  } catch (caught) {
    const status = (caught as { $metadata?: { httpStatusCode?: number } })
      .$metadata?.httpStatusCode;
    const name = (caught as { name?: string }).name;
    if (status !== 404 && name !== "NotFound" && name !== "NoSuchBucket") {
      throw new WorkTrellisError(
        `Could not inspect object-storage bucket "${resource.bucket}".`,
        {
          cause: caught,
          remediation: `${resource.endpoint} — verify the endpoint and credentials.`,
        },
      );
    }
  }

  step("bucket", `creating ${resource.bucket}`);
  try {
    await client.send(
      new CreateBucketCommand({
        Bucket: resource.bucket,
        ...(resource.region !== "us-east-1"
          ? {
              CreateBucketConfiguration: {
                LocationConstraint: resource.region as never,
              },
            }
          : {}),
      }),
    );
  } catch (caught) {
    if ((caught as { name?: string }).name !== "BucketAlreadyOwnedByYou") {
      throw caught;
    }
  }
}

function resolveEndpoint(
  compose: ComposeContext,
  endpoint: ResourceEndpoint,
  host = "127.0.0.1",
): ResolvedResourceEndpoint {
  const stack = compose.stacks[endpoint.stack];
  const hostPort = stack?.ports[endpoint.port];
  if (!stack || !hostPort) {
    throw new WorkTrellisError(
      `Resource references unavailable Compose port "${endpoint.stack}.${endpoint.port}".`,
    );
  }

  return {
    ...endpoint,
    host,
    hostPort,
    url: (scheme = "http") => `${scheme}://${host}:${hostPort}`,
  };
}

function postgresUrl(options: {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}): string {
  return `postgresql://${encodeURIComponent(options.user)}:${encodeURIComponent(
    options.password,
  )}@${options.host}:${options.port}/${encodeURIComponent(options.database)}`;
}

function resolveString(
  value: ResourceString | undefined,
  context: ResourceResolveContext,
  fallback: string,
): string {
  const resolved = typeof value === "function" ? value(context) : value;
  return resolved ?? fallback;
}
