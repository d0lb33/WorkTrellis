# Migrate to configuration version 2

> Historical migration: current WorkTrellis releases require configuration v3.
> Complete this migration first when starting from v1, then follow
> [the v3 migration guide](migration-to-v3.md).

WorkTrellis 0.2 deliberately makes a clean break from configuration version 1.
It does not translate v1 service definitions or import `.devstack` state.

## Add a project-owned Compose file

Move the services formerly described in TypeScript into a normal committed
Compose file:

```yaml
# compose.worktrellis.yml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
  redis:
    image: redis:7-alpine
  minio:
    image: minio/minio:latest
    command: ["server", "/data"]
  mailpit:
    image: axllent/mailpit:latest
```

Add volumes, networks, health checks, commands, and image-specific settings
there. WorkTrellis no longer models any container type.

## Replace `services` with Compose and adapters

```diff
-import { defineConfig } from "worktrellis";
+import {
+  defineConfig,
+  postgresDatabase,
+  redisNamespace,
+  s3Bucket,
+} from "worktrellis";

 export default defineConfig({
-  configVersion: 1,
+  configVersion: 2,
   project: "acme",

-  services: [
-    { kind: "postgres", version: "16" },
-    { kind: "redis", version: "7" },
-    { kind: "minio" },
-    { kind: "mailpit" },
+  compose: [
+    {
+      name: "infrastructure",
+      scope: "machine",
+      files: ["compose.worktrellis.yml"],
+      ports: {
+        database: { service: "postgres", containerPort: 5432 },
+        redis: { service: "redis", containerPort: 6379 },
+        s3: { service: "minio", containerPort: 9000 },
+        mail: { service: "mailpit", containerPort: 1025 },
+      },
   ],

-  env: ({ workspace, services, url }) => ({
-    DATABASE_URL: services.postgres?.urlFor(workspace.databaseName),
-    REDIS_URL: services.redis?.urlFor(workspace.redisDb),
-    S3_ENDPOINT: services.minio?.endpoint,
-    S3_BUCKET: workspace.bucketName,
+  resources: {
+    database: postgresDatabase({
+      endpoint: { stack: "infrastructure", port: "database" },
+      isolation: "database",
+    }),
+    cache: redisNamespace({
+      endpoint: { stack: "infrastructure", port: "redis" },
+      isolation: "namespace",
+    }),
+    storage: s3Bucket({
+      endpoint: { stack: "infrastructure", port: "s3" },
+      isolation: "bucket",
+    }),
+  },
+
+  env: ({ resources, url }) => ({
+    DATABASE_URL: resources.database.url,
+    REDIS_URL: resources.cache.url,
+    S3_ENDPOINT: resources.storage.endpoint,
+    S3_BUCKET: resources.storage.bucket,
     PORT: String(url.listenPort),
   }),
+
+  db: {
+    resource: "database",
+    // existing hooks...
+  },
 });
```

Rename `extraPorts` to `processPorts`. Container ports belong in the relevant
`compose[].ports` declaration.

## Local state

Version 2 uses only:

- `<worktree>/.worktrellis` for generated workspace state;
- `~/.worktrellis` for machine-wide state; and
- `WORKTRELLIS_HOME` as the optional machine-state override.

Remove obsolete `.devstack` directories only after deciding that their old
containers, volumes, and databases are no longer needed. WorkTrellis does not
delete them and does not reuse them.

The first v2 start creates new Compose projects and isolated resources. If old
development data matters, export it first and restore it through a
project-owned, safety-checked script.
