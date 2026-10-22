import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./apps/web/src", import.meta.url)) },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          include: ["tests/unit/**/*.test.ts", "apps/web/tests/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          environment: "node",
          include: ["tests/integration/**/*.test.ts"],
          testTimeout: 10000,
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["packages/domain/src/**/*.ts"],
      reporter: ["text", "json-summary", "lcov", "html"],
      reportsDirectory: "coverage/domain",
    },
  },
});
