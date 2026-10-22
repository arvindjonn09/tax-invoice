import { assertTestDatabase, loadLocalEnvironment } from "./environment.mjs";
import { runPrisma } from "./prisma.mjs";

try {
  loadLocalEnvironment();
  const target = assertTestDatabase();
  if (process.env.RESET_TEST_DATABASE !== "yes")
    throw new Error(
      "Set RESET_TEST_DATABASE=yes to confirm resetting local jobflow_test",
    );
  runPrisma(["migrate", "reset", "--force"], {
    ...process.env,
    DATABASE_URL: target.toString(),
  });
  console.log("Local jobflow_test reset and migrations reapplied");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
