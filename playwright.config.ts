import { defineConfig } from "@playwright/test";
const port = Number(process.env.JOBFLOW_E2E_PORT ?? 3100);
const baseURL = `http://127.0.0.1:${port}`;
export default defineConfig({
  testDir: "./tests/e2e",
  reporter: [["list"], ["html", { open: "never" }]],
  use: { baseURL },
  webServer: {
    command: `pnpm --filter @jobflow/web exec next dev --hostname 127.0.0.1 --port ${port}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
  },
});
