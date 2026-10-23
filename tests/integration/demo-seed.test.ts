import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../packages/database/src/generated/prisma/client";
import { createAuth } from "../../apps/web/src/server/auth/config";
import {
  DEMO_COMPANY_ID,
  DEMO_USERS,
  assertDemoSeedAllowed,
  seedDemo,
} from "../../apps/web/src/server/demo/seed";
import { randomBytes } from "node:crypto";
import {
  type CommittedDatabase,
  withCommittedDatabase,
} from "../helpers/committed-database";

const PASSWORD = "synthetic demo password";
const ORIGIN = "http://127.0.0.1:3000";
let database: CommittedDatabase;
let db: PrismaClient;

beforeAll(async () => {
  database = await withCommittedDatabase();
  db = database.client;
}, 60_000);
afterAll(() => database?.release());

describe("demo seed guards", () => {
  it.each([
    [
      { NODE_ENV: "production", DEMO_SEED: "yes" },
      "never be seeded in production",
    ],
    [
      { APP_ENV: "production", DEMO_SEED: "yes" },
      "never be seeded in production",
    ],
    [{ NODE_ENV: "development" }, "DEMO_SEED=yes"],
  ])("refuses %j", async (env, message) => {
    expect(() => assertDemoSeedAllowed(env)).toThrow(message);
    await expect(seedDemo(db, { password: PASSWORD, env })).rejects.toThrow(
      message,
    );
    expect(await db.company.count({ where: { id: DEMO_COMPANY_ID } })).toBe(0);
    expect(
      await db.user.count({ where: { email: { endsWith: "@example.test" } } }),
    ).toBe(0);
  });
});

describe("seedDemo", () => {
  const env = { NODE_ENV: "development", DEMO_SEED: "yes" };

  it("creates one flagged demo company with one synthetic user per role", async () => {
    expect(await seedDemo(db, { password: PASSWORD, env })).toEqual({
      createdUsers: 5,
      createdMemberships: 5,
      createdCompany: true,
    });
    const company = await db.company.findUniqueOrThrow({
      where: { id: DEMO_COMPANY_ID },
    });
    expect(company.isDemo).toBe(true);
    const memberships = await db.membership.findMany({
      where: { companyId: DEMO_COMPANY_ID },
      include: { user: { select: { email: true } } },
    });
    expect(memberships.map((m) => [m.role, m.user.email]).sort()).toEqual(
      DEMO_USERS.map((u) => [u.role, u.email]).sort(),
    );
    for (const user of DEMO_USERS)
      expect(user.email).toMatch(/@example\.test$/);
  });

  it("is idempotent: a second run creates nothing and changes no password", async () => {
    const before = await db.authAccount.findMany({
      orderBy: { id: "asc" },
      select: { id: true, password: true },
    });
    expect(
      await seedDemo(db, { password: "a different password!", env }),
    ).toEqual({
      createdUsers: 0,
      createdMemberships: 0,
      createdCompany: false,
    });
    expect(await db.company.count({ where: { id: DEMO_COMPANY_ID } })).toBe(1);
    expect(
      await db.membership.count({ where: { companyId: DEMO_COMPANY_ID } }),
    ).toBe(5);
    expect(
      await db.authAccount.findMany({
        orderBy: { id: "asc" },
        select: { id: true, password: true },
      }),
    ).toEqual(before);
  });

  it("demo users can sign in locally but are refused when production is on", async () => {
    const signIn = (production: boolean) =>
      createAuth({
        db,
        secret: randomBytes(32).toString("hex"),
        baseURL: ORIGIN,
        production,
      }).handler(
        new Request(`${ORIGIN}/api/auth/sign-in/email`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: ORIGIN,
            "x-forwarded-for": production ? "192.0.2.2" : "192.0.2.1",
          },
          body: JSON.stringify({
            email: "demo-owner@example.test",
            password: PASSWORD,
          }),
        }),
      );
    expect((await signIn(false)).status).toBe(200);
    expect((await signIn(true)).status).toBe(403);
  });
});
