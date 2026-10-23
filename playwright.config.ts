import { existsSync, readFileSync } from "node:fs";
import { defineConfig } from "@playwright/test";

// Signed-in tests use the local/CI database from the root .env (pnpm db:env)
// unless DATABASE_URL is already set. Without one they skip.
if (!process.env.DATABASE_URL && existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const match = /^(DATABASE_URL|BETTER_AUTH_SECRET)=(.*)$/.exec(line);
    if (match?.[1] && match[2]) process.env[match[1]] ??= match[2];
  }
}
const port = Number(process.env.JOBFLOW_E2E_PORT ?? 3100);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("Invalid JOBFLOW_E2E_PORT");
const baseURL = `http://127.0.0.1:${port}`;
const serverEnv: Record<string, string> = process.env.DATABASE_URL
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
    env: serverEnv,
  },
});
