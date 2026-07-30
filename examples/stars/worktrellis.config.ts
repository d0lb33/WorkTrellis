import {
  defineConfig,
  postgresDatabase,
  redisNamespace,
  s3Bucket,
} from "worktrellis";

export default defineConfig({
  configVersion: 2,
  project: "stars-local",
  baseEnvFile: ".env",

  compose: [
    {
      name: "local",
      scope: "machine",
      files: ["../compose.worktrellis.yml"],
      ports: {
        database: {
          service: "postgres",
          containerPort: 5432,
          probe: { kind: "postgres" },
        },
        redis: {
          service: "redis",
          containerPort: 6379,
          probe: { kind: "redis" },
        },
        s3: {
          service: "minio",
          containerPort: 9000,
          probe: { kind: "http", path: "/minio/health/live" },
        },
        mail: {
          service: "mailpit",
          containerPort: 1025,
          probe: { kind: "smtp" },
        },
      },
    },
  ],

  resources: {
    database: postgresDatabase({
      endpoint: { stack: "local", port: "database" },
      isolation: "database",
    }),
    cache: redisNamespace({
      endpoint: { stack: "local", port: "redis" },
      isolation: "namespace",
    }),
    storage: s3Bucket({
      endpoint: { stack: "local", port: "s3" },
      isolation: "bucket",
    }),
  },

  url: { provider: "auto", wildcard: true, basePort: 3000 },

  env: ({ workspace, compose, resources, url }) => ({
    DATABASE_URL: resources.database.url,
    REALTIME_DATABASE_URL: resources.database.url,
    REDIS_URL: resources.cache.url,
    QUEUE_PREFIX: resources.cache.prefix,
    REDIS_KEY_PREFIX: `${resources.cache.prefix}:`,
    S3_ENDPOINT: resources.storage.endpoint,
    S3_BUCKET: resources.storage.bucket,
    S3_REGION: resources.storage.region,
    S3_ACCESS_KEY: resources.storage.accessKey,
    S3_SECRET_KEY: resources.storage.secretKey,
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: String(compose.stacks.local!.ports.mail),
    PORT: String(url.listenPort),
    BETTER_AUTH_URL: url.appUrl,
    ROOT_DOMAIN: url.rootDomain,
    BETTER_AUTH_COOKIE_DOMAIN: url.cookieDomain,
    BETTER_AUTH_COOKIE_PREFIX: `stars-${workspace.slug}`,
    WORKTRELLIS_DATABASE_NAME: resources.database.database,
  }),

  criticalKeys: [
    "DATABASE_URL",
    "REALTIME_DATABASE_URL",
    "REDIS_URL",
    "QUEUE_PREFIX",
    "REDIS_KEY_PREFIX",
    "S3_BUCKET",
    "S3_ENDPOINT",
    "BETTER_AUTH_URL",
    "ROOT_DOMAIN",
    "PORT",
  ],

  processes: [
    {
      name: "app",
      bindsAppPort: true,
      color: "blue",
      command: { node: ["node_modules/next/dist/bin/next", "dev", "--turbo"] },
      readyWhen: { logMatch: /Ready in|Local:\s+http/i, timeoutMs: 180_000 },
    },
    {
      name: "worker",
      color: "magenta",
      command: {
        node: [
          "node_modules/tsx/dist/cli.mjs",
          "--watch",
          "src/server/worker/index.ts",
        ],
      },
    },
  ],

  db: {
    resource: "database",
    schemaFingerprintFiles: ["prisma/schema.prisma", "prisma/migrations"],
    migrate: (context) =>
      context.exec(context.bin("prisma"), ["migrate", "deploy"]),
    seed: (context) =>
      context.exec(context.bin("tsx"), ["prisma/dev-seed.ts"]),
  },
});
