// Apply DEMO_PASSWORD from .env to the existing demo accounts (#268):
//   pnpm db:demo:password
// Refused in production. The password is never logged.
import { createDatabaseClient } from "../../packages/database/src/index";
import { setDemoPassword } from "../../apps/web/src/server/demo/seed";
import { loadLocalEnvironment, requireDatabaseUrl } from "./environment.mjs";

loadLocalEnvironment();
try {
  const url = requireDatabaseUrl(process.env.DATABASE_URL);
  const password = process.env.DEMO_PASSWORD;
  if (!password) {
    throw new Error("Set DEMO_PASSWORD in .env (12-128 characters).");
  }
  const db = createDatabaseClient(url.toString());
  try {
    const result = await setDemoPassword(db, { password, env: process.env });
    if (result.updatedUsers === 0) {
      throw new Error("No demo accounts found. Run pnpm db:seed:demo first.");
    }
    console.log(
      `Demo password updated for ${result.updatedUsers} accounts; ${result.endedSessions} sessions signed out.`,
    );
  } finally {
    await db.$disconnect();
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
