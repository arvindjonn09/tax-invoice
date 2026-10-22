import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  // Generate/validate do not connect. Migration scripts require DATABASE_URL.
  datasource: {
    url:
      process.env.DATABASE_URL ?? "postgresql://localhost/jobflow_unconfigured",
  },
});
