import { defineConfig } from "@playwright/test";

// #65: smoke tests against a deployed environment (staging), never a local
// server. Run with `SMOKE_BASE_URL=https://… pnpm test:smoke`. Synthetic data
// only: the signed-in part runs only when SMOKE_EMAIL and SMOKE_PASSWORD name
// a synthetic owner account on that environment.
const baseURL = process.env.SMOKE_BASE_URL;
// Credentials are only ever sent to an allow-listed origin: the staging site,
// or a local server for a dry run of the suite itself. Add a host here (in a
// reviewed PR) to smoke-test another environment.
const ALLOWED_ORIGINS = [
  /^https:\/\/jobflow\.shivomsangha\.com$/,
  /^http:\/\/127\.0\.0\.1:\d+$/,
];
if (!baseURL || !ALLOWED_ORIGINS.some((origin) => origin.test(baseURL)))
  throw new Error(
    "SMOKE_BASE_URL must be an allow-listed origin (playwright.smoke.config.ts)",
  );

export default defineConfig({
  testDir: "./tests/smoke",
  // Console output only. No HTML report, trace or screenshot is written: the
  // repository is public, an uploaded artifact is downloadable by anyone signed
  // in to GitHub, and a trace records the sign-in form's values and cookies.
  reporter: [["list"]],
  // No retries: a retried sign-in would spend the environment's login throttle.
  retries: 0,
  workers: 1,
  expect: { timeout: 15_000 },
  use: {
    baseURL,
    locale: "en-AU",
    timezoneId: "Australia/Sydney",
    trace: "off",
    screenshot: "off",
    video: "off",
  },
});
