import { loadLocalEnvironment, requireDatabaseUrl } from "./environment.mjs";
import { runPrisma } from "./prisma.mjs";

try {
  loadLocalEnvironment();
  const arguments_ = process.argv.slice(2);
  if (arguments_[0] === "migrate") requireDatabaseUrl(process.env.DATABASE_URL);
  if (arguments_.includes("reset"))
    throw new Error("Use pnpm db:test:reset for guarded resets");
  if (
    arguments_.includes("dev") &&
    (process.env.NODE_ENV === "production" ||
      process.env.APP_ENV === "production")
  ) {
    throw new Error("Development migrations are forbidden in production");
  }
  process.stdout.write(runPrisma(arguments_));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
