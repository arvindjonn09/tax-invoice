import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./apps/web/src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: [
      "tests/{unit,integration}/**/*.test.ts",
      "apps/web/tests/**/*.test.ts",
    ],
  },
});
