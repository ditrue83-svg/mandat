import { defineConfig } from "drizzle-kit";
// This config generates SQL only. Applying migrations uses scripts/migrate.ts
// and the same verified TLS settings as the application and worker.
export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
});
