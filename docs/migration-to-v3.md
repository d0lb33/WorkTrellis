# Migrating to configuration v3

WorkTrellis 0.3 requires `configVersion: 3`. It removes image-specific
credential defaults from resource adapters and narrows the JSON status contract
so diagnostics do not expose secrets or private host paths.

## 1. Update the configuration version

```diff
 export default defineConfig({
-  configVersion: 2,
+  configVersion: 3,
```

## 2. Declare project-owned resource credentials

PostgreSQL and S3-compatible credentials must now be explicit. They must match
the project-owned Compose service configuration.

For fixed local-development credentials:

```diff
 database: postgresDatabase({
   endpoint: { stack: "local", port: "database" },
   isolation: "database",
+  user: "postgres",
+  password: "postgres",
 }),

 storage: s3Bucket({
   endpoint: { stack: "local", port: "s3" },
   isolation: "bucket",
+  accessKey: "minioadmin",
+  secretKey: "minioadmin",
 }),
```

For credentials kept in the project's secrets file, resolve them from
`baseEnv`:

```ts
database: postgresDatabase({
  endpoint: { stack: "local", port: "database" },
  isolation: "database",
  user: ({ baseEnv }) => baseEnv.POSTGRES_USER,
  password: ({ baseEnv }) => baseEnv.POSTGRES_PASSWORD,
}),
storage: s3Bucket({
  endpoint: { stack: "local", port: "s3" },
  isolation: "bucket",
  accessKey: ({ baseEnv }) => baseEnv.S3_ACCESS_KEY,
  secretKey: ({ baseEnv }) => baseEnv.S3_SECRET_KEY,
}),
```

An absent or empty required credential fails before resource provisioning.
WorkTrellis does not write these values to the project's secrets file.

## 3. Update `status --json` consumers

`worktrellis status --json` no longer includes:

- `workspace.root`;
- `url.providerEnv`; or
- raw resolved resource objects.

The `resources` value is now an array of safe `{ name, detail }` descriptions.
Compose diagnostic details and credential-bearing URLs are redacted.

Human-readable `worktrellis status` output is unchanged.

## 4. Verify before starting

```bash
pnpm worktrellis:doctor
pnpm worktrellis:env --explain
pnpm dev
```

Unsupported configuration versions are rejected before WorkTrellis changes
infrastructure.
