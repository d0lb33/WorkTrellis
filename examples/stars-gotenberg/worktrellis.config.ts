import {
  defineConfig,
  postgresDatabase,
  redisNamespace,
  s3Bucket,
} from "worktrellis";

export default defineConfig({
  configVersion: 3,
  project: "stars-local",

  compose: [
    {
      name: "local",
      scope: "machine",
      files: ["../compose.worktrellis.yml"],
      ports: {
        database: { service: "postgres", containerPort: 5432 },
        redis: { service: "redis", containerPort: 6379 },
        s3: { service: "minio", containerPort: 9000 },
        mail: { service: "mailpit", containerPort: 1025 },
      },
    },
    {
      name: "documents",
      scope: "workspace",
      files: ["compose.dev.yml"],
      ports: {
        gotenberg: {
          service: "gotenberg",
          containerPort: 3000,
          probe: { kind: "http", path: "/health" },
        },
      },
    },
  ],

  resources: {
    database: postgresDatabase({
      endpoint: { stack: "local", port: "database" },
      isolation: "database",
      user: "postgres",
      password: "postgres",
    }),
    cache: redisNamespace({
      endpoint: { stack: "local", port: "redis" },
      isolation: "namespace",
    }),
    storage: s3Bucket({
      endpoint: { stack: "local", port: "s3" },
      isolation: "bucket",
      accessKey: "minioadmin",
      secretKey: "minioadmin",
    }),
  },

  env: ({ compose, resources, url }) => ({
    DATABASE_URL: resources.database.url,
    REDIS_URL: resources.cache.url,
    S3_ENDPOINT: resources.storage.endpoint,
    S3_BUCKET: resources.storage.bucket,
    GOTENBERG_URL: compose.url("documents", "gotenberg"),
    PORT: String(url.listenPort),
  }),

  processes: [
    {
      name: "app",
      bindsAppPort: true,
      command: { node: ["node_modules/next/dist/bin/next", "dev", "--turbo"] },
    },
    {
      name: "worker",
      command: {
        node: [
          "node_modules/tsx/dist/cli.mjs",
          "--watch",
          "src/server/worker/index.ts",
        ],
      },
    },
  ],

  db: { resource: "database" },
});
