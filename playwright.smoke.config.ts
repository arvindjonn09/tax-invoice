import { defineConfig } from "@playwright/test";

// #65: smoke tests against a deployed environment (staging), never a local
// server. Run with `SMOKE_BASE_URL=https://… pnpm test:smoke`. Synthetic data
// only: the signed-in part runs only when SMOKE_EMAIL and SMOKE_PASSWORD name
// a synthetic owner account on that environment.
const baseURL = process.env.SMOKE_BASE_URL;
// An https origin, or a local server for a dry run of the suite itself.
if (
  !baseURL ||
  !/^(https:\/\/[a-z0-9.-]+|http:\/\/127\.0\.0\.1:\d+)$/i.test(baseURL)
)
  throw new Error("Set SMOKE_BASE_URL to the https origin to smoke-test");

export default defineConfig({
  testDir: "./tests/smoke",
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "smoke-report" }],
  ],
  // No retries: a retried sign-in would spend the environment's login throttle.
  retries: 0,
  workers: 1,
  expect: { timeout: 15_000 },
  use: {
    baseURL,
    locale: "en-AU",
    timezoneId: "Australia/Sydney",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
