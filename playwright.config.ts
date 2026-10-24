import { defineConfig } from "@playwright/test";

// Run through `pnpm test:e2e` (scripts/database/e2e-runner.mjs): signed-in
// specs get a disposable migrated database marked by
// JOBFLOW_ISOLATED_TEST_DATABASE; without it they skip.
const isolated = Boolean(process.env.JOBFLOW_ISOLATED_TEST_DATABASE);
const port = Number(process.env.JOBFLOW_E2E_PORT ?? 3100);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("Invalid JOBFLOW_E2E_PORT");
const baseURL = `http://127.0.0.1:${port}`;
const serverEnv: Record<string, string> =
  isolated && process.env.DATABASE_URL
    ? {
        DATABASE_URL: process.env.DATABASE_URL,
        BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? "",
        // Origin checks need the exact origin the browser uses.
        BETTER_AUTH_URL: baseURL,
      }
    : {};
export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  reporter: [["list"], ["html", { open: "never" }]],
  // `next dev` compiles each route on its first visit (CI runs a cold dev
  // server), and pages then load their data client-side; 5 s is too tight.
  expect: { timeout: 15_000 },
  use: {
    baseURL,
    locale: "en-AU",
    timezoneId: "Australia/Sydney",
    // No colour transitions mid-axe-scan after theme switches or clicks
    // (the app's CSS drops transitions under reduced motion).
    reducedMotion: "reduce",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: `pnpm --filter @jobflow/web exec next dev --hostname 127.0.0.1 --port ${port}`,
    url: baseURL,
    reuseExistingServer: false,
    env: serverEnv,
  },
});
