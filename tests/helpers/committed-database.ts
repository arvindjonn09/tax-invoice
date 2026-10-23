import type { PrismaClient } from "../../packages/database/src/generated/prisma/client";
import { createDatabaseClient } from "../../packages/database/src/index";
import { withIsolatedDatabase } from "../../scripts/database/test-runner.mjs";
import { isolatedTestConnection } from "./test-environment";

export type CommittedDatabase = {
  client: PrismaClient;
  /** Connection URL of the disposable database (for raw `pg` clients). */
  url: string;
  /** Disconnect and drop the database; call from afterAll. */
  release: () => Promise<void>;
};

/**
 * A separate migrated database for tests that must COMMIT (e.g. audited
 * transactions), so committed rows never reach the shared run database.
 * Provision once per file in beforeAll and release it in afterAll.
 */
export async function withCommittedDatabase(): Promise<CommittedDatabase> {
  // Validate we are inside `pnpm test:integration` before touching anything.
  isolatedTestConnection();
  const base = new URL(process.env.TEST_DATABASE_URL ?? "");
  base.pathname = "/jobflow_test";

  let ready!: (environment: NodeJS.ProcessEnv) => void;
  let finish!: () => void;
  const environmentReady = new Promise<NodeJS.ProcessEnv>((resolve) => {
    ready = resolve;
  });
  const done = withIsolatedDatabase(
    (environment) => {
      ready(environment);
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    },
    { ...process.env, TEST_DATABASE_URL: base.toString() },
  );
  const environment = await Promise.race([
    environmentReady,
    done.then(() => {
      throw new Error("Committed test database closed before use");
    }),
  ]);
  const client = createDatabaseClient(environment.DATABASE_URL ?? "");
  return {
    client,
    url: environment.DATABASE_URL ?? "",
    release: async () => {
      await client.$disconnect();
      finish();
      await done;
    },
  };
}
