import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import {
  assertTestDatabase,
  loadLocalEnvironment,
  repositoryRoot,
} from "./environment.mjs";
import { runPrisma } from "./prisma.mjs";

const require = createRequire(
  new URL("../../packages/database/package.json", import.meta.url),
);
const { Client } = require("pg");

export async function withIsolatedDatabase(run, environment = process.env) {
  const base = assertTestDatabase(environment);
  const name = `jobflow_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({
    connectionString: base.toString(),
    connectionTimeoutMillis: 5000,
  });
  let created = false;
  try {
    await admin.connect();
    // Name is generated internally from a UUID, never from a URL/user input.
    await admin.query(
      `CREATE DATABASE "${name}" TEMPLATE template0 ENCODING 'UTF8'`,
    );
    created = true;
    const target = new URL(base);
    target.pathname = `/${name}`;
    const isolated = {
      ...environment,
      DATABASE_URL: target.toString(),
      TEST_DATABASE_URL: target.toString(),
      JOBFLOW_ISOLATED_TEST_DATABASE: name,
    };
    runPrisma(["migrate", "deploy"], isolated);
    return await run(isolated);
  } finally {
    try {
      if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  }
}

async function main() {
  loadLocalEnvironment();
  let activeChild;
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
    activeChild?.kill("SIGINT");
  };
  const terminate = () => {
    interrupted = true;
    activeChild?.kill("SIGTERM");
  };
  // Install before provisioning: signals during setup still reach finally cleanup.
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    const status = await withIsolatedDatabase((environment) => {
      if (interrupted) throw new Error("Integration setup interrupted");
      return new Promise((resolve, reject) => {
        activeChild = spawn(
          "pnpm",
          [
            "exec",
            "vitest",
            "run",
            "--project",
            "integration",
            ...process.argv.slice(2),
          ],
          {
            cwd: repositoryRoot,
            env: environment,
            stdio: "inherit",
          },
        );
        activeChild.once("error", reject);
        activeChild.once("exit", (code, signal) => {
          activeChild = undefined;
          if (signal || interrupted)
            reject(new Error("Integration process interrupted"));
          else resolve(code ?? 1);
        });
      });
    });
    process.exitCode = status;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  }
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  main().catch(() => {
    console.error(
      "Database integration setup or cleanup failed (connection details redacted)",
    );
    process.exitCode = 1;
  });
}
