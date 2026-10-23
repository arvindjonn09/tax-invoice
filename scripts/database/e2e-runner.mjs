import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { loadLocalEnvironment, repositoryRoot } from "./environment.mjs";
import { withIsolatedDatabase } from "./test-runner.mjs";

// `pnpm test:e2e`: browser tests against a disposable, migrated database
// (created from TEST_DATABASE_URL and dropped afterwards), never the
// development or any shared database. Without TEST_DATABASE_URL the
// signed-in specs skip and only public pages are tested.

function playwright(environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "pnpm",
      ["exec", "playwright", "test", ...process.argv.slice(2)],
      { cwd: repositoryRoot, env: environment, stdio: "inherit" },
    );
    const forward = (signal) => child.kill(signal);
    process.on("SIGINT", forward);
    process.on("SIGTERM", forward);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      process.removeListener("SIGINT", forward);
      process.removeListener("SIGTERM", forward);
      if (signal) reject(new Error("Browser tests interrupted"));
      else resolve(code ?? 1);
    });
  });
}

async function main() {
  loadLocalEnvironment();
  if (!process.env.TEST_DATABASE_URL) {
    const withoutDatabase = { ...process.env };
    delete withoutDatabase.DATABASE_URL;
    process.exitCode = await playwright(withoutDatabase);
    return;
  }
  process.exitCode = await withIsolatedDatabase(
    (isolated) =>
      playwright({
        ...isolated,
        // A throwaway signing secret per run unless one is configured.
        BETTER_AUTH_SECRET:
          isolated.BETTER_AUTH_SECRET ?? randomBytes(32).toString("hex"),
      }),
    // withIsolatedDatabase replaces DATABASE_URL with the throwaway database;
    // the development database is only used to check the two differ.
    process.env,
  );
}

main().catch(() => {
  console.error("Browser test setup or cleanup failed (details redacted)");
  process.exitCode = 1;
});
