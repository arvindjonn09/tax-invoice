import { defineConfig } from "@playwright/test";

// Run through `pnpm test:e2e` (scripts/database/e2e-runner.mjs): signed-in
// specs get a disposable migrated database marked by
// JOBFLOW_ISOLATED_TEST_DATABASE; without it they skip.
const isolated = Boolean(process.env.JOBFLOW_ISOLATED_TEST_DATABASE);
const port = Number(process.env.JOBFLOW_E2E_PORT ?? 3100);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("Invalid JOBFLOW_E2E_PORT");
const baseURL = `http://127.0.0.1:${port}`;
/**
 * #330: CI runs against the production build `pnpm build` made just before
 * (`next start`); `next dev` dropped connections and served pages before they
 * were ready, failing a different test each run. Locally it's `next dev`
 * unless JOBFLOW_E2E_SERVER=start (after `pnpm build`).
 */
const productionBuild =
  process.env.JOBFLOW_E2E_SERVER === "start" ||
  (Boolean(process.env.CI) && process.env.JOBFLOW_E2E_SERVER !== "dev");
/**
 * `next start` sets NODE_ENV=production, so the app is told it isn't the real
 * production site: demo-safe auth, no required scanner or Turnstile (#261,
 * #217), and no email sweep, so tests still read queued email themselves.
 */
const buildSafety: Record<string, string> = productionBuild
  ? { APP_ENV: "development", EMAIL_SWEEP: "off" }
  : {};
/** Must match tests/e2e/operator.spec.ts. */
const E2E_OPERATOR_ID = "00000000-0000-4000-8000-00000000e2e0";
const serverEnv: Record<string, string> =
  isolated && process.env.DATABASE_URL
    ? {
        DATABASE_URL: process.env.DATABASE_URL,
        BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? "",
        EMAIL_OUTBOX_KEY: process.env.EMAIL_OUTBOX_KEY ?? "",
        // Never send real email from tests: the console transport logs links.
        SMTP_HOST: "",
        // Origin checks need the exact origin the browser uses.
        BETTER_AUTH_URL: baseURL,
        // The one operator operator.spec.ts creates (#232), second key of D5.
        JOBFLOW_OPERATOR_USER_IDS: E2E_OPERATOR_ID,
        ...buildSafety,
      }
    : buildSafety;
export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  reporter: [["list"], ["html", { open: "never" }]],
  // `next dev` occasionally dropped a connection or served a page before it
  // was ready. CI now uses the production build (#330); the retry stays until
  // three consecutive CI runs pass without using it, then it comes out.
  retries: process.env.CI ? 1 : 0,
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
    command: `pnpm --filter @jobflow/web exec next ${productionBuild ? "start" : "dev"} --hostname 127.0.0.1 --port ${port}`,
    url: baseURL,
    reuseExistingServer: false,
    env: serverEnv,
  },
});
