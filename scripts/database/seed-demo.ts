// Seed synthetic demo data into the LOCAL database:
//   DEMO_SEED=yes pnpm db:seed:demo
//   DEMO_PASSWORD=<12+ characters, never committed> is required for new users.
// The password is never logged.
import { createDatabaseClient } from "../../packages/database/src/index";
import {
  DEMO_USERS,
  assertDemoSeedAllowed,
  seedDemo,
} from "../../apps/web/src/server/demo/seed";
import { loadLocalEnvironment, requireDatabaseUrl } from "./environment.mjs";

loadLocalEnvironment();
try {
  assertDemoSeedAllowed(process.env);
  const url = requireDatabaseUrl(process.env.DATABASE_URL);
  const password = process.env.DEMO_PASSWORD;
  if (!password) {
    throw new Error(
      "Set DEMO_PASSWORD (12+ characters) to the password for the demo users.",
    );
  }
  const db = createDatabaseClient(url.toString());
  try {
    const result = await seedDemo(db, { password, env: process.env });
    console.log(
      `Demo data ready (${result.createdUsers} users, ${result.createdMemberships} memberships created${result.createdCompany ? ", company created" : ""}).`,
    );
    console.log(
      `Sign in as: ${DEMO_USERS.map((user) => user.email).join(", ")}`,
    );
  } finally {
    await db.$disconnect();
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
