import type {
  Company,
  Membership,
  MembershipRole,
  Prisma,
  PrismaClient,
  User,
} from "../../packages/database/src/generated/prisma/client";
import type { Database } from "./database";
import {
  assertScope,
  createSequence,
  syntheticCompanyName,
  syntheticEmail,
  syntheticPersonName,
} from "./synthetic";

export type CompanyWithOwner = {
  company: Company;
  owner: User;
  ownerMembership: Membership;
};

function inTransaction<T>(
  db: Database,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  // The company's creator FK is deferred to commit, so company + first owner
  // must share one transaction. Reuse the caller's transaction when given one.
  return "$transaction" in db
    ? (db as PrismaClient).$transaction(work)
    : work(db);
}

/**
 * Deterministic factories for synthetic tenancy records. Use one scope per test
 * file (e.g. "invoices") so parallel files never collide on unique emails.
 */
export function createFactories(scope: string) {
  assertScope(scope);
  const next = createSequence();

  async function user(db: Database): Promise<User> {
    const n = next();
    return db.user.create({
      data: {
        email: syntheticEmail(scope, n),
        name: syntheticPersonName(scope, n),
      },
    });
  }

  /** Company, its owner and the owner's bootstrap membership; demo by default. */
  async function companyWithOwner(
    db: Database,
    options: { isDemo?: boolean } = {},
  ): Promise<CompanyWithOwner> {
    return inTransaction(db, async (tx) => {
      const owner = await user(tx);
      const company = await tx.company.create({
        data: {
          name: syntheticCompanyName(scope, next()),
          isDemo: options.isDemo ?? true,
          createdBy: owner.id,
        },
      });
      const ownerMembership = await tx.membership.create({
        data: {
          companyId: company.id,
          userId: owner.id,
          createdBy: owner.id,
          role: "owner",
        },
      });
      return { company, owner, ownerMembership };
    });
  }

  /** A new user added to an existing company by one of its members. */
  async function member(
    db: Database,
    input: { companyId: string; createdBy: string; role: MembershipRole },
  ): Promise<{ user: User; membership: Membership }> {
    const added = await user(db);
    const membership = await db.membership.create({
      data: {
        companyId: input.companyId,
        userId: added.id,
        createdBy: input.createdBy,
        role: input.role,
      },
    });
    return { user: added, membership };
  }

  return { user, companyWithOwner, member };
}
