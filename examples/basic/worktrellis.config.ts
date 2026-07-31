import { defineConfig, postgresDatabase } from "worktrellis";

export default defineConfig({
  configVersion: 3,
  project: "basic",

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
  },

  env: ({ resources, url }) => ({
    DATABASE_URL: resources.database.url,
    PORT: String(url.listenPort),
    APP_URL: url.appUrl,
  }),

  processes: [
    {
      name: "app",
      bindsAppPort: true,
      command: { node: ["server.mjs"] },
    },
  ],

  db: { resource: "database" },
});
