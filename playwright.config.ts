import { defineConfig } from "@playwright/test";
const port = Number(process.env.JOBFLOW_E2E_PORT ?? 3100);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("Invalid JOBFLOW_E2E_PORT");
const baseURL = `http://127.0.0.1:${port}`;
export default defineConfig({
  testDir: "./tests/e2e",
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    locale: "en-AU",
    timezoneId: "Australia/Sydney",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: `pnpm --filter @jobflow/web exec next dev --hostname 127.0.0.1 --port ${port}`,
    url: baseURL,
    reuseExistingServer: false,
  },
});
