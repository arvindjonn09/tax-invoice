import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const alias = {
  "@": fileURLToPath(new URL("./apps/web/src", import.meta.url)),
};
// Deterministic runs: UTC zone and fixed file order. Tests that need "now" use
// fake timers or the factories' fixed reference instant, never the real clock.
const deterministic = {
  environment: "node" as const,
  env: { TZ: "UTC" },
  sequence: { shuffle: false },
};

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          ...deterministic,
          name: "unit",
          include: [
            "tests/unit/**/*.test.ts",
            "apps/web/tests/**/*.test.ts",
            "packages/*/test/**/*.test.ts",
          ],
        },
      },
      {
        resolve: { alias },
        test: {
          ...deterministic,
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["packages/domain/src/**/*.ts"],
      reporter: ["text", "json-summary", "html"],
      reportsDirectory: "coverage",
      // The shared GST/profit core (#17) must stay fully covered.
      thresholds: {
        lines: 100,
        branches: 100,
        functions: 100,
        statements: 100,
      },
    },
  },
});
