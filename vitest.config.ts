import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["tests/unit/**/*.test.ts"],
        },
      },
      {
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
