import { createDatabaseClient } from "../../packages/database/src/index";
import type {
  Prisma,
  PrismaClient,
} from "../../packages/database/src/generated/prisma/client";

export type Database = PrismaClient | Prisma.TransactionClient;

/** Refuse to run integration tests outside `pnpm test:integration`'s disposable database. */
export function connectIsolatedDatabase(): PrismaClient {
  if (
    !/^jobflow_test_[a-f0-9]{32}$/.test(
      process.env.JOBFLOW_ISOLATED_TEST_DATABASE ?? "",
    )
  ) {
    throw new Error("Use pnpm test:integration for an isolated database");
  }
  return createDatabaseClient(process.env.DATABASE_URL ?? "");
}

class RollbackSignal extends Error {}

/**
 * Run `work` in a transaction that is always rolled back, so a test leaves no rows.
 * Deferred constraints are checked before the rollback (SET CONSTRAINTS ALL
 * IMMEDIATE), so integrity violations still fail the test instead of being
 * silently discarded with the transaction.
 */
export async function withRollback<T>(
  client: PrismaClient,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  let result: { value: T } | undefined;
  try {
    await client.$transaction(async (tx) => {
      const value = await work(tx);
      await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");
      result = { value };
      throw new RollbackSignal();
    });
  } catch (error) {
    if (!(error instanceof RollbackSignal)) throw error;
  }
  if (!result) throw new Error("Rollback transaction produced no result");
  return result.value;
}
