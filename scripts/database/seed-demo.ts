// Seed synthetic demo data into the LOCAL database:
//   DEMO_SEED=yes pnpm db:seed:demo
// Optional DEMO_PASSWORD (12+ characters); otherwise a random one is printed.
import { randomBytes } from "node:crypto";
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
  const password =
    process.env.DEMO_PASSWORD ?? randomBytes(12).toString("base64url");
  const db = createDatabaseClient(url.toString());
  try {
    const result = await seedDemo(db, { password, env: process.env });
    console.log(
      `Demo data ready (${result.createdUsers} users, ${result.createdMemberships} memberships created${result.createdCompany ? ", company created" : ""}).`,
    );
    if (result.createdUsers > 0 && !process.env.DEMO_PASSWORD) {
      console.log(`Local demo password for new users: ${password}`);
    }
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
