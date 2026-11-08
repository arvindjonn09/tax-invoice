import type {
  Company,
  Prisma,
  PrismaClient,
} from "../../packages/database/src/generated/prisma/client";

/**
 * #260: a company's access mode and trial dates change only in a transaction
 * that declared the 'operator' key (companies_trial_columns_guard). Tests set
 * up trial state the way the operator would, in a transaction of its own.
 */
export function operatorUpdate(
  db: PrismaClient,
  args: Prisma.CompanyUpdateArgs,
): Promise<Company> {
  return db.$transaction((tx) => operatorUpdateInTx(tx, args));
}

/**
 * The same inside a transaction the test already opened. The key is set for
 * this update only, and whatever key was there before is put back, so a test
 * of another exemption isn't changed by it.
 */
export async function operatorUpdateInTx(
  tx: Prisma.TransactionClient,
  args: Prisma.CompanyUpdateArgs,
): Promise<Company> {
  const rows = await tx.$queryRaw<{ previous: string }[]>`
    SELECT coalesce(current_setting('jobflow.read_only_exemption', true), '') AS previous`;
  const previous = rows[0]?.previous ?? "";
  await tx.$executeRaw`SELECT set_config('jobflow.read_only_exemption', 'operator', true)`;
  // On failure the transaction is aborted anyway, so restore only on success
  // (a restore after an error would hide the real error).
  const updated = await tx.company.update(args);
  await tx.$executeRaw`SELECT set_config('jobflow.read_only_exemption', ${previous}, true)`;
  return updated;
}
