import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);
it("parallel harness runs have different databases and clean up after success/failure", async () => {
  // Restore the known base URL; each nested harness creates and removes its own DB.
  const base = new URL(process.env.TEST_DATABASE_URL ?? "");
  base.pathname = "/jobflow_test";
  const env = { ...process.env, TEST_DATABASE_URL: base.toString() };
  const run = async (fail: boolean) => {
    const source = `import { withIsolatedDatabase } from './scripts/database/test-runner.mjs';
let name;
try { await withIsolatedDatabase(async env => { name = env.JOBFLOW_ISOLATED_TEST_DATABASE; ${fail ? "throw new Error('expected test failure');" : ""} }); }
catch (error) { if (!${fail}) throw error; }
console.log(name);`;
    const { stdout } = await execute(
      process.execPath,
      ["--input-type=module", "-e", source],
      { env },
    );
    return stdout.trim();
  };
  const [first, second] = await Promise.all([run(false), run(true)]);
  expect(first).toMatch(/^jobflow_test_[a-f0-9]{32}$/);
  expect(second).toMatch(/^jobflow_test_[a-f0-9]{32}$/);
  expect(first).not.toBe(second);
  const { createDatabaseClient } =
    await import("../../packages/database/src/index");
  const client = createDatabaseClient(process.env.DATABASE_URL ?? "");
  try {
    const rows = await client.$queryRaw<
      { datname: string }[]
    >`SELECT datname FROM pg_database WHERE datname = ${first} OR datname = ${second}`;
    expect(rows).toEqual([]);
  } finally {
    await client.$disconnect();
  }
}, 30000);
