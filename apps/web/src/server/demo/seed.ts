import type { Role } from "@jobflow/authz";
import type { PrismaClient } from "../../../../../packages/database/src/generated/prisma/client";
import { createCredentialUser } from "../auth/credentials";

/** Fixed id so re-running the seed finds, rather than duplicates, the demo company. */
export const DEMO_COMPANY_ID = "d0000000-0000-4000-8000-000000000001";
export const DEMO_COMPANY_NAME = "Sample Contracting Co (Demo)";

/** One synthetic user per role; `.test` is a reserved TLD (no real inbox). */
export const DEMO_USERS: readonly {
  role: Role;
  email: string;
  name: string;
}[] = [
  { role: "owner", email: "demo-owner@example.test", name: "Demo Owner" },
  { role: "manager", email: "demo-manager@example.test", name: "Demo Manager" },
  {
    role: "accountant",
    email: "demo-accountant@example.test",
    name: "Demo Accountant",
  },
  {
    role: "employee",
    email: "demo-employee@example.test",
    name: "Demo Employee",
  },
  {
    role: "subcontractor",
    email: "demo-subcontractor@example.test",
    name: "Demo Subcontractor",
  },
];

export type SeedEnvironment = Readonly<Record<string, string | undefined>>;

/** Demo data is never seeded into production, and only on explicit request. */
export function assertDemoSeedAllowed(env: SeedEnvironment): void {
  if (env.NODE_ENV === "production" || env.APP_ENV === "production") {
    throw new Error("Demo data must never be seeded in production");
  }
  if (env.DEMO_SEED !== "yes") {
    throw new Error("Set DEMO_SEED=yes to confirm seeding synthetic demo data");
  }
}

export type SeedResult = {
  createdUsers: number;
  createdMemberships: number;
  createdCompany: boolean;
};

/**
 * Idempotent: creates whatever is missing and leaves existing demo records
 * (and their passwords) unchanged, so it can run any number of times.
 */
export async function seedDemo(
  db: PrismaClient,
  options: { password: string; env: SeedEnvironment },
): Promise<SeedResult> {
  assertDemoSeedAllowed(options.env);
  return db.$transaction(async (tx) => {
    const result: SeedResult = {
      createdUsers: 0,
      createdMemberships: 0,
      createdCompany: false,
    };
    const userIds = new Map<Role, string>();
    for (const demo of DEMO_USERS) {
      const existing = await tx.user.findUnique({
        where: { email: demo.email },
        select: { id: true },
      });
      const id =
        existing?.id ??
        (
          await createCredentialUser(tx, {
            email: demo.email,
            name: demo.name,
            password: options.password,
          })
        ).id;
      if (!existing) result.createdUsers += 1;
      userIds.set(demo.role, id);
    }
    const ownerId = userIds.get("owner") ?? "";
    const company = await tx.company.findUnique({
      where: { id: DEMO_COMPANY_ID },
      select: { isDemo: true },
    });
    if (company && !company.isDemo) {
      throw new Error("The demo company id is in use by a non-demo company");
    }
    if (!company) {
      // The company's creator FK is deferred, so company + owner membership share this transaction.
      await tx.company.create({
        data: {
          id: DEMO_COMPANY_ID,
          name: DEMO_COMPANY_NAME,
          isDemo: true,
          createdBy: ownerId,
        },
      });
      result.createdCompany = true;
    }
    for (const demo of DEMO_USERS) {
      const userId = userIds.get(demo.role) ?? "";
      const membership = await tx.membership.findUnique({
        where: { companyId_userId: { companyId: DEMO_COMPANY_ID, userId } },
        select: { id: true },
      });
      if (!membership) {
        await tx.membership.create({
          data: {
            companyId: DEMO_COMPANY_ID,
            userId,
            createdBy: ownerId,
            role: demo.role,
          },
        });
        result.createdMemberships += 1;
      }
    }
    return result;
  });
}
