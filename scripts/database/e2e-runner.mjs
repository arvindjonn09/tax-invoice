import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { loadLocalEnvironment, repositoryRoot } from "./environment.mjs";
import { withIsolatedDatabase } from "./test-runner.mjs";

// Browser tests that create users must never mutate the developer's database.
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
process.on("SIGINT", interrupt);
process.on("SIGTERM", terminate);
try {
  process.exitCode = await withIsolatedDatabase((environment) => {
    if (interrupted) throw new Error("Browser setup interrupted");
    return new Promise((resolve, reject) => {
      const port = environment.JOBFLOW_E2E_PORT ?? "3100";
      activeChild = spawn(
        "pnpm",
        ["exec", "playwright", "test", ...process.argv.slice(2)],
        {
          cwd: repositoryRoot,
          env: {
            ...environment,
            APP_ENV: "development",
            BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
            BETTER_AUTH_URL: `http://127.0.0.1:${port}`,
          },
          stdio: "inherit",
        },
      );
      activeChild.once("error", reject);
      activeChild.once("exit", (code, signal) => {
        activeChild = undefined;
        if (signal || interrupted)
          reject(new Error("Browser tests interrupted"));
        else resolve(code ?? 1);
      });
    });
  });
} catch {
  console.error(
    "Browser test setup, execution or cleanup failed (connection details redacted)",
  );
  process.exitCode = 1;
} finally {
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", terminate);
}
