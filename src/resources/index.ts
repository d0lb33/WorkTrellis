import type {
  AnyResourceAdapter,
  ComposeContext,
  PostgresDatabase,
  RedisNamespace,
  ResolvedResourceEndpoint,
  ResolvedResources,
  ResourceAdapter,
  ResourceAdapters,
  ResourceDeprovisionResult,
  ResourceEndpoint,
  ResourceResolveContext,
  S3Bucket,
  WorkspaceIdentity,
} from "../types";
import { WorkTrellisError } from "../core/errors";
import { hostForUrl } from "../platform/engine-endpoint";
import {
  buildBucketName,
  buildDatabaseName,
  buildRedisPrefix,
} from "../core/naming";
import { hexModulo } from "../util/hash";
import { step } from "../util/log";
import {
  createDatabase,
  databaseExists,
  deprovisionWorkspaceDatabase,
} from "./postgres";

export type ResourceString = string | ((
  context: ResourceResolveContext,
) => string | undefined);

export interface PostgresDatabaseOptions {
  endpoint: ResourceEndpoint;
  isolation: "database";
  /** Project-owned login matching the configured PostgreSQL service. */
  user: ResourceString;
  /** Project-owned credential or base-environment resolver. */
  password: ResourceString;
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
  /** Project-owned access key or base-environment resolver. */
  accessKey: ResourceString;
  /** Project-owned secret key or base-environment resolver. */
  secretKey: ResourceString;
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
      const user = resolveRequiredString(
        options.user,
        context,
        "postgresDatabase().user",
      );
      const password = resolveRequiredString(
        options.password,
        context,
        "postgresDatabase().password",
      );
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
    deprovision: (resource, context) =>
      deprovisionWorkspaceDatabase({
        databaseUrl: resource.url,
        name: resource.database,
        project: context.workspace.project,
        slug: context.workspace.slug,
        dryRun: context.dryRun,
      }),
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
        url: `redis://${hostForUrl(endpoint.host)}:${endpoint.hostPort}/${database}`,
      };
    },
    describe: (resource) =>
      `database ${resource.database}, prefix ${resource.prefix}`,
    // No deprovision hook: logical database indexes are shared by hash across
    // worktrees, and only callers that honor the prefix keep keys inside it, so
    // WorkTrellis cannot prove which keys belong to one workspace.
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
        accessKey: resolveRequiredString(
          options.accessKey,
          context,
          "s3Bucket().accessKey",
        ),
        secretKey: resolveRequiredString(
          options.secretKey,
          context,
          "s3Bucket().secretKey",
        ),
        region: resolveString(options.region, context, "us-east-1"),
      };
    },
    describe: (resource) => `bucket ${resource.bucket}`,
    provision: ensureObjectStorageBucket,
    deprovision: (resource, context) =>
      deprovisionObjectStorageBucket(resource, context.dryRun),
  });
}

export function resolveResources<
  TAdapters extends ResourceAdapters,
>(options: {
  adapters?: TAdapters;
  compose: ComposeContext;
  identity: WorkspaceIdentity;
  baseEnv?: Readonly<Record<string, string>>;
}): ResolvedResources<TAdapters> {
  const adapters = options.adapters ?? ({} as TAdapters);
  const resources: Record<string, unknown> = {};

  for (const [name, adapter] of Object.entries(adapters)) {
    const endpoint = resolveResourceEndpoint(
      options.compose,
      adapter.endpoint,
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
}): Promise<void> {
  const skipped = new Set(options.skip ?? []);
  for (const [name, adapter] of Object.entries(options.adapters ?? {})) {
    if (!adapter.provision || skipped.has(name)) continue;
    const endpoint = resolveResourceEndpoint(
      options.compose,
      adapter.endpoint,
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

async function objectStorageClient(resource: S3Bucket) {
  const sdk = await import("@aws-sdk/client-s3");
  const client = new sdk.S3Client({
    endpoint: resource.endpoint,
    region: resource.region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: resource.accessKey,
      secretAccessKey: resource.secretKey,
    },
  });
  return { sdk, client };
}

/** True when the bucket exists; false for a definite "not found". */
async function objectStorageBucketExists(
  resource: S3Bucket,
  client: Awaited<ReturnType<typeof objectStorageClient>>,
): Promise<boolean> {
  try {
    await client.client.send(
      new client.sdk.HeadBucketCommand({ Bucket: resource.bucket }),
    );
    return true;
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
    return false;
  }
}

async function ensureObjectStorageBucket(resource: S3Bucket): Promise<void> {
  const storage = await objectStorageClient(resource);
  const { client } = storage;
  const { CreateBucketCommand } = storage.sdk;
  if (await objectStorageBucketExists(resource, storage)) return;

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

/**
 * Empty and delete a pruned worktree's bucket. A versioned bucket is refused:
 * deleting current objects would leave prior versions behind and the bucket
 * itself could not be removed.
 */
async function deprovisionObjectStorageBucket(
  resource: S3Bucket,
  dryRun: boolean,
): Promise<ResourceDeprovisionResult> {
  const storage = await objectStorageClient(resource);
  const { client, sdk } = storage;
  if (!(await objectStorageBucketExists(resource, storage))) {
    return { status: "absent" };
  }

  try {
    const versioning = await client.send(
      new sdk.GetBucketVersioningCommand({ Bucket: resource.bucket }),
    );
    if (versioning.Status === "Enabled" || versioning.Status === "Suspended") {
      return { status: "refused", detail: "bucket versioning is enabled" };
    }
  } catch (caught) {
    // Some S3-compatible servers do not implement versioning at all.
    if ((caught as { name?: string }).name !== "NotImplemented") throw caught;
  }

  const keys: string[] = [];
  let bytes = 0;
  let continuationToken: string | undefined;
  do {
    const page = await client.send(
      new sdk.ListObjectsV2Command({
        Bucket: resource.bucket,
        ContinuationToken: continuationToken,
      }),
    );
    for (const object of page.Contents ?? []) {
      if (object.Key === undefined) continue;
      keys.push(object.Key);
      bytes += object.Size ?? 0;
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);

  const detail = `${keys.length} object(s)`;
  if (dryRun) return { status: "would-remove", bytes, detail };

  for (let index = 0; index < keys.length; index += 1_000) {
    const deleted = await client.send(
      new sdk.DeleteObjectsCommand({
        Bucket: resource.bucket,
        Delete: {
          Objects: keys.slice(index, index + 1_000).map((Key) => ({ Key })),
          Quiet: true,
        },
      }),
    );
    if ((deleted.Errors?.length ?? 0) > 0) {
      throw new WorkTrellisError(
        `Could not delete ${deleted.Errors!.length} object(s) from bucket "${resource.bucket}".`,
      );
    }
  }
  await client.send(new sdk.DeleteBucketCommand({ Bucket: resource.bucket }));
  return { status: "removed", bytes, detail };
}

export function resolveResourceEndpoint(
  compose: ComposeContext,
  endpoint: ResourceEndpoint,
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
    host: compose.host,
    hostPort,
    url: (scheme = "http") =>
      `${scheme}://${hostForUrl(compose.host)}:${hostPort}`,
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
  )}@${hostForUrl(options.host)}:${options.port}/${encodeURIComponent(options.database)}`;
}

function resolveString(
  value: ResourceString | undefined,
  context: ResourceResolveContext,
  fallback: string,
): string {
  const resolved = typeof value === "function" ? value(context) : value;
  return resolved ?? fallback;
}

function resolveRequiredString(
  value: ResourceString | undefined,
  context: ResourceResolveContext,
  field: string,
): string {
  const resolved = typeof value === "function" ? value(context) : value;
  if (resolved?.trim()) return resolved;

  throw new WorkTrellisError(`${field} must resolve to a non-empty value.`, {
    remediation:
      "Declare the credential in the project-owned adapter configuration, or resolve it from `baseEnv`.",
  });
}
