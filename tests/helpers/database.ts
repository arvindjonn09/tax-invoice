import type { Prisma } from "../../packages/database/src/generated/prisma/client";
import { createDatabaseClient } from "../../packages/database/src/index";

import { isolatedTestConnection } from "./test-environment";

/** Each invocation rolls back after success, assertion failure or database failure. */
export async function withTestDatabase<T>(
  run: (database: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const client = createDatabaseClient(isolatedTestConnection());
  const rollback = new Error("Intentional test rollback");
  let result!: T;
  try {
    await client.$transaction(
      async (database) => {
        result = await run(database);
        throw rollback;
      },
      { maxWait: 5000, timeout: 10000 },
    );
    throw new Error("Test transaction unexpectedly committed");
  } catch (error) {
    if (error !== rollback) throw error;
    return result;
  } finally {
    await client.$disconnect();
  }
}
