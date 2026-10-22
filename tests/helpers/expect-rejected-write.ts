import { expect } from "vitest";
import type { Prisma } from "../../packages/database/src/generated/prisma/client";

/** PostgreSQL aborts a transaction after an error; restore it before the next assertion. */
export async function expectRejectedWrite(
  database: Prisma.TransactionClient,
  run: () => Promise<unknown>,
  message?: string,
) {
  await database.$executeRawUnsafe("SAVEPOINT rejected_write");
  try {
    await expect(run()).rejects.toThrow(message);
  } finally {
    await database.$executeRawUnsafe("ROLLBACK TO SAVEPOINT rejected_write");
    await database.$executeRawUnsafe("RELEASE SAVEPOINT rejected_write");
  }
}
