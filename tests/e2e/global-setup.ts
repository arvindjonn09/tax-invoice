import { randomBytes, randomUUID } from "node:crypto";
import { createDatabaseClient } from "../../packages/database/src/index";
import { createCredentialUser } from "../../apps/web/src/server/auth/credentials";
import { E2E_ACCOUNTS_ENV, type E2eAccounts } from "./accounts";

const ROLES = [
  "owner",
  "manager",
  "accountant",
  "employee",
  "subcontractor",
] as const;

/**
 * Signed-in browser tests need real accounts. With a migrated DATABASE_URL
 * (CI, or a developer's local database) this creates one synthetic company
 * and one user per role, with fresh emails and a random password per run, so
 * reruns never collide and nothing secret is committed. Without a database,
 * signed-in specs skip.
 */
export default async function globalSetup() {
  const url = process.env.DATABASE_URL;
  if (!url) return;
  const run = randomUUID().slice(0, 8);
  const password = randomBytes(18).toString("base64url");
  const db = createDatabaseClient(url);
  try {
    const users = {} as Record<(typeof ROLES)[number], string>;
    for (const role of ROLES) {
      const user = await createCredentialUser(db, {
        email: `e2e-${run}-${role}@jobflow.invalid`,
        name: `E2E ${role}`,
        password,
      });
      users[role] = user.id;
    }
    const companyId = randomUUID();
    await db.$transaction(async (tx) => {
      await tx.company.create({
        data: {
          id: companyId,
          name: `E2E Sample Company ${run}`,
          createdBy: users.owner,
          isDemo: true,
        },
      });
      await tx.membership.create({
        data: {
          companyId,
          userId: users.owner,
          createdBy: users.owner,
          role: "owner",
        },
      });
    });
    for (const role of ROLES.slice(1)) {
      await db.membership.create({
        data: { companyId, userId: users[role], createdBy: users.owner, role },
      });
    }
    const accounts: E2eAccounts = {
      password,
      emails: Object.fromEntries(
        ROLES.map((role) => [role, `e2e-${run}-${role}@jobflow.invalid`]),
      ) as E2eAccounts["emails"],
    };
    // Playwright passes env set here to every worker; nothing touches disk.
    process.env[E2E_ACCOUNTS_ENV] = JSON.stringify(accounts);
  } finally {
    await db.$disconnect();
  }
}
