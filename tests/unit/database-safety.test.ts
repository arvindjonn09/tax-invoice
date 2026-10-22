import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

const development = "postgresql://synthetic:synthetic@127.0.0.1:5432/jobflow";
const test = "postgresql://synthetic:synthetic@127.0.0.1:5432/jobflow_test";
const guard = `import { assertTestDatabase } from './scripts/database/environment.mjs';
try { assertTestDatabase(JSON.parse(process.env.GUARD_ENV)); }
catch (error) { console.error(error.message); process.exitCode = 1; }`;

it.each([
  { NODE_ENV: "production" },
  { APP_ENV: "production" },
  { TEST_DATABASE_URL: development },
  { TEST_DATABASE_URL: test.replace("127.0.0.1", "remote.example.invalid") },
  { TEST_DATABASE_URL: `${test}?options=-csearch_path%3Dpublic` },
  { TEST_DATABASE_URL: `${test}?schema=public` },
  { TEST_DATABASE_URL: `${test}#ignored` },
  { TEST_DATABASE_URL: test.replace("jobflow_test", "jobflow_test_other") },
  { TEST_DATABASE_URL: "not-a-url-with-secret" },
  { DATABASE_URL: test.replace("127.0.0.1", "localhost") },
  { DATABASE_URL: `${test}?schema=other` },
  { DATABASE_URL: development.replace("jobflow", "%6aobflow_test") },
  { DATABASE_URL: development.replace("jobflow", "jobflow%5ftest") },
  { DATABASE_URL: `${development}?dbname=jobflow_test` },
  { DATABASE_URL: development.replace("jobflow", "%invalid") },
  { DATABASE_URL: "" },
])("rejects unsafe reset or test target before connecting: %j", (overrides) => {
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", guard],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        GUARD_ENV: JSON.stringify({
          DATABASE_URL: development,
          TEST_DATABASE_URL: test,
          ...overrides,
        }),
      },
    },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).not.toContain("synthetic:");
  expect(result.stderr).not.toContain("not-a-url-with-secret");
});

it("accepts a distinct loopback test database", () => {
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", guard],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        GUARD_ENV: JSON.stringify({
          DATABASE_URL: development,
          TEST_DATABASE_URL: test,
        }),
      },
    },
  );
  expect(result.status).toBe(0);
});

it("requires a separate acknowledgement before destructive reset", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/database/reset-test.mjs"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_ENV: "test",
        APP_ENV: "test",
        DATABASE_URL: development,
        TEST_DATABASE_URL: test,
        RESET_TEST_DATABASE: "",
      },
    },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("RESET_TEST_DATABASE=yes");
  expect(result.stderr).not.toContain("synthetic:");
});

it("runs the integration entry point from a path containing a URL fragment character", () => {
  const root = mkdtempSync(join(tmpdir(), "jobflow-entry-"));
  const link = join(root, "checkout #9");
  try {
    symlinkSync(process.cwd(), link, "junction");
    const result = spawnSync(
      process.execPath,
      [
        "--preserve-symlinks-main",
        join(link, "scripts/database/test-runner.mjs"),
      ],
      {
        encoding: "utf8",
        env: { ...process.env, APP_ENV: "production" },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Database integration setup or cleanup failed",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
