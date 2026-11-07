import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../packages/database/src/generated/prisma/client";
import { createAuth } from "../../apps/web/src/server/auth/config";
import { createCredentialUser } from "../../apps/web/src/server/auth/credentials";
import { createWithPolicy } from "../../apps/web/src/server/authz/policy";
import {
  setupChecklistFor,
  setupChecklistHandlers,
} from "../../apps/web/src/server/company/setup-checklist";
import {
  type CommittedDatabase,
  withCommittedDatabase,
} from "../helpers/committed-database";
import { syntheticFactory } from "../helpers/factories";

// #225 (S5 AC8): the owner's "Finish setting up your company" checklist and
// POST /api/company/setup-checklist/dismiss — owners only, audited once.
const ORIGIN = "http://127.0.0.1:3000";
const PASSWORD = "correct horse battery staple";
const ROLES = ["owner", "manager"] as const;
type Role = (typeof ROLES)[number];

let database: CommittedDatabase;
let db: PrismaClient;
let dismiss: (request: Request) => Promise<Response>;
let companyId = "";
let otherCompanyId = "";
const userIds = {} as Record<Role | "outsider", string>;
const cookies = {} as Record<Role, Headers>;
const factory = syntheticFactory(0x2250);

beforeAll(async () => {
  database = await withCommittedDatabase();
  db = database.client;
  const auth = createAuth({
    db,
    secret: randomBytes(32).toString("hex"),
    baseURL: ORIGIN,
    production: false,
  });
  const withPolicy = createWithPolicy({
    auth: () => auth,
    db: () => db,
    trustedOrigins: () => [ORIGIN],
  });
  const handlers = setupChecklistHandlers(() => db);
  const route = withPolicy("company.update", handlers.dismiss);
  dismiss = (request) => route(request, undefined);
  for (const key of [...ROLES, "outsider"] as const) {
    userIds[key] = (
      await createCredentialUser(db, {
        email: `checklist-${key}@jobflow.invalid`,
        name: `Synthetic ${key}`,
        password: PASSWORD,
      })
    ).id;
  }
  const own = factory.company(userIds.owner);
  const other = factory.company(userIds.outsider);
  for (const [record, owner] of [
    [own, userIds.owner],
    [other, userIds.outsider],
  ] as const) {
    await db.$transaction(async (tx) => {
      await tx.company.create({ data: record });
      await tx.membership.create({
        data: factory.membership(record.id, owner),
      });
    });
  }
  companyId = own.id;
  otherCompanyId = other.id;
  await db.membership.create({
    data: {
      companyId,
      userId: userIds.manager,
      createdBy: userIds.owner,
      role: "manager",
    },
  });
  let ip = 40;
  for (const role of ROLES) {
    const response = await auth.handler(
      new Request(`${ORIGIN}/api/auth/sign-in/email`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: ORIGIN,
          "x-forwarded-for": `203.0.113.${(ip += 1)}`,
        },
        body: JSON.stringify({
          email: `checklist-${role}@jobflow.invalid`,
          password: PASSWORD,
        }),
      }),
    );
    expect(response.status).toBe(200);
    cookies[role] = new Headers({
      cookie: response.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; "),
    });
  }
}, 90_000);
afterAll(() => database?.release());

function post(role: Role): Request {
  const headers = new Headers(cookies[role]);
  headers.set("origin", ORIGIN);
  return new Request(`${ORIGIN}/api/company/setup-checklist/dismiss`, {
    method: "POST",
    headers,
  });
}

const dismissals = (id: string) =>
  db.auditEvent.count({
    where: { companyId: id, action: "company.setup_checklist_dismissed" },
  });

const unrestricted = { readOnly: false };

describe("setup checklist", () => {
  it("lists the missing address for the owner only", async () => {
    const owner = { userId: userIds.owner, companyId, role: "owner" as const };
    expect(await setupChecklistFor(db, owner, unrestricted)).toEqual([
      expect.objectContaining({ id: "business_details", done: false }),
    ]);
    expect(
      await setupChecklistFor(db, { ...owner, role: "manager" }, unrestricted),
    ).toBeNull();
    expect(await setupChecklistFor(db, owner, { readOnly: true })).toBeNull();
  });

  it("refuses a manager without changing anything", async () => {
    const response = await dismiss(post("manager"));
    expect(response.status).toBe(403);
    const company = await db.company.findUniqueOrThrow({
      where: { id: companyId },
    });
    expect(company.setupChecklistDismissedAt).toBeNull();
    expect(await dismissals(companyId)).toBe(0);
  });

  it("dismisses once for the owner's company, audited once", async () => {
    const first = await dismiss(post("owner"));
    expect(first.status).toBe(200);
    const { dismissedAt } = (await first.json()) as { dismissedAt: string };
    const second = await dismiss(post("owner"));
    expect(second.status).toBe(200);
    expect(((await second.json()) as { dismissedAt: string }).dismissedAt).toBe(
      dismissedAt,
    );
    expect(await dismissals(companyId)).toBe(1);
    const event = await db.auditEvent.findFirstOrThrow({
      where: { companyId, action: "company.setup_checklist_dismissed" },
    });
    expect(event.createdBy).toBe(userIds.owner);
    // No personal details in the audit metadata (shared AC b).
    expect(JSON.stringify(event.metadata)).not.toMatch(/@|\d{11}/);
    const owner = { userId: userIds.owner, companyId, role: "owner" as const };
    expect(await setupChecklistFor(db, owner, unrestricted)).toBeNull();
    // Another company's checklist is untouched.
    const other = await db.company.findUniqueOrThrow({
      where: { id: otherCompanyId },
    });
    expect(other.setupChecklistDismissedAt).toBeNull();
    expect(await dismissals(otherCompanyId)).toBe(0);
  });
});
