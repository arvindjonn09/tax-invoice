import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../../packages/authz/src/index";
import { addDays, sydneyDate, trialStatus } from "../../packages/domain/src";
import type { PrismaClient } from "../../packages/database/src/generated/prisma/client";
import { resolveActor } from "../../apps/web/src/server/auth/actor";
import type { Auth } from "../../apps/web/src/server/auth/config";
import {
  DEFAULT_SUPPORT_EMAIL,
  trialHandlers,
} from "../../apps/web/src/server/trial/handlers";
import {
  type CommittedDatabase,
  withCommittedDatabase,
} from "../helpers/committed-database";
import { syntheticFactory } from "../helpers/factories";

// #221: trial access in actor resolution, GET /api/company/trial and the
// trial permissions.
let database: CommittedDatabase;
let client: PrismaClient;
const factory = syntheticFactory(0x2210);
const owner = factory.user();
let companyId = "";
let demoId = "";
const ROLES = [
  "owner",
  "manager",
  "accountant",
  "employee",
  "subcontractor",
] as const;
const users = Object.fromEntries(ROLES.map((role) => [role, factory.user()]));

beforeAll(async () => {
  database = await withCommittedDatabase();
  client = database.client;
  await client.user.create({ data: owner });
  for (const user of Object.values(users))
    await client.user.create({ data: user });
  const company = { ...factory.company(owner.id), isDemo: false };
  const demo = factory.company(owner.id);
  for (const created of [company, demo])
    await client.$transaction(async (tx) => {
      await tx.company.create({ data: created });
      await tx.membership.create({
        data: factory.membership(created.id, owner.id),
      });
    });
  companyId = company.id;
  demoId = demo.id;
  for (const role of ROLES)
    await client.membership.create({
      data: {
        ...factory.membership(companyId, users[role]!.id),
        role,
        createdBy: owner.id,
      },
    });
}, 60_000);
afterAll(() => database?.release());

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const today = () => sydneyDate(new Date());

function setTrial(lastDay: string | null, extensions = 0) {
  return client.company.update({
    where: { id: companyId },
    data:
      lastDay === null
        ? { accessMode: "unrestricted" }
        : {
            accessMode: "trial",
            trialStartedAt: new Date("2026-01-01T00:00:00Z"),
            trialLastDay: day(lastDay),
            trialExtensionCount: extensions,
          },
  });
}

/** A stand-in for Better Auth's session lookup. */
function fakeAuth(userId: string, activeCompanyId: string | null) {
  return {
    api: {
      getSession: async () => ({
        user: {
          id: userId,
          email: `${userId}@example.test`,
          emailVerified: true,
        },
        session: { id: "synthetic-session", activeCompanyId },
      }),
    },
  } as unknown as Auth;
}

/** Counts every database call made through the client. */
function counting(db: PrismaClient) {
  let calls = 0;
  const wrap = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(object, property, receiver) {
        const value = Reflect.get(object, property, receiver);
        if (typeof value === "function")
          return (...args: unknown[]) => {
            calls += 1;
            return value.apply(object, args);
          };
        if (
          value &&
          typeof value === "object" &&
          typeof property === "string" &&
          !property.startsWith("$")
        )
          return wrap(value as object);
        return value;
      },
    });
  return { db: wrap(db), calls: () => calls };
}

async function access(
  userId: string,
  activeCompanyId: string | null = companyId,
) {
  const result = await resolveActor(
    fakeAuth(userId, activeCompanyId),
    client,
    new Headers(),
  );
  if (result.status !== "active")
    throw new Error(`unexpected ${result.status}`);
  return result.actor.access;
}

describe("actor.access from resolveActor", () => {
  it("is unrestricted for pre-M6 and demo companies, never read-only", async () => {
    await setTrial(null);
    expect(await access(owner.id)).toEqual({
      mode: "unrestricted",
      lastDay: null,
      readOnly: false,
    });
    expect(await access(owner.id, demoId)).toEqual({
      mode: "unrestricted",
      lastDay: null,
      readOnly: false,
    });
  });

  it("reports a running trial and an expired one, judged by the database clock", async () => {
    const lastDay = addDays(today(), 5);
    await setTrial(lastDay);
    expect(await access(owner.id)).toEqual({
      mode: "trial",
      lastDay,
      readOnly: false,
    });
    await setTrial("2020-01-01");
    expect(await access(users.employee!.id)).toEqual({
      mode: "trial",
      lastDay: "2020-01-01",
      readOnly: true,
    });
  });

  it("adds no query: one database call resolves memberships and access", async () => {
    await setTrial("2020-01-01");
    const counted = counting(client);
    const result = await resolveActor(
      fakeAuth(owner.id, companyId),
      counted.db,
      new Headers(),
    );
    expect(result.status).toBe("active");
    expect(counted.calls()).toBe(1);
  });

  it("still lists companies to choose from without access details", async () => {
    const result = await resolveActor(
      fakeAuth(owner.id, null),
      client,
      new Headers(),
    );
    expect(result).toMatchObject({ status: "choose-company" });
    if (result.status !== "choose-company") return;
    for (const company of result.companies)
      expect(Object.keys(company).sort()).toEqual(["companyId", "role"]);
  });
});

describe("GET /api/company/trial", () => {
  const handlers = trialHandlers(() => client, { SUPPORT_EMAIL: "" });
  async function status(role: (typeof ROLES)[number], company = companyId) {
    const actor: Actor = { userId: users[role]!.id, companyId: company, role };
    const response = await handlers.status({
      actor,
      request: new Request("http://localhost/api/company/trial"),
      context: undefined,
    });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    return (await response.json()) as Record<string, unknown>;
  }
  const FULL = [
    "daysRemaining",
    "extended",
    "lastDay",
    "mode",
    "phase",
    "readOnlyFrom",
    "supportEmail",
  ];

  it("gives owner, manager and accountant the full status, and the others only readOnly", async () => {
    await setTrial(addDays(today(), 6));
    for (const role of ["owner", "manager", "accountant"] as const)
      expect(Object.keys(await status(role)).sort()).toEqual(FULL);
    for (const role of ["employee", "subcontractor"] as const)
      expect(await status(role)).toEqual({ readOnly: false });
  });

  it("matches packages/domain for phase and days remaining", async () => {
    const lastDay = addDays(today(), 6);
    await setTrial(lastDay, 1);
    const expected = trialStatus(lastDay, new Date());
    const body = await status("owner");
    expect(body).toMatchObject({
      mode: "trial",
      lastDay,
      phase: expected.phase,
      daysRemaining: expected.daysRemaining,
      supportEmail: DEFAULT_SUPPORT_EMAIL,
      extended: true,
    });
    expect(expected).toEqual({ daysRemaining: 7, phase: "warning" });
    const company = await client.company.findUniqueOrThrow({
      where: { id: companyId },
    });
    expect(body.readOnlyFrom).toBe(company.readOnlyFrom?.toISOString());
  });

  it("shows an expired trial as expired, and as read-only to workers", async () => {
    await setTrial("2020-01-01");
    expect(await status("manager")).toMatchObject({
      mode: "trial",
      phase: "expired",
    });
    expect(await status("subcontractor")).toEqual({ readOnly: true });
  });

  it("returns unrestricted, never read-only, for unrestricted and demo companies", async () => {
    await setTrial(null);
    const unrestricted = {
      mode: "unrestricted",
      phase: null,
      daysRemaining: null,
      lastDay: null,
      readOnlyFrom: null,
      supportEmail: DEFAULT_SUPPORT_EMAIL,
      extended: false,
    };
    expect(await status("accountant")).toEqual(unrestricted);
    expect(await status("employee")).toEqual({ readOnly: false });
    const actor: Actor = { userId: owner.id, companyId: demoId, role: "owner" };
    const demo = await handlers.status({
      actor,
      request: new Request("http://localhost/api/company/trial"),
      context: undefined,
    });
    expect(await demo.json()).toEqual(unrestricted);
  });

  it("uses the configured support address", async () => {
    const configured = trialHandlers(() => client, {
      SUPPORT_EMAIL: "support@synthetic.example",
    });
    const actor: Actor = { userId: owner.id, companyId, role: "owner" };
    const response = await configured.status({
      actor,
      request: new Request("http://localhost/api/company/trial"),
      context: undefined,
    });
    expect(await response.json()).toMatchObject({
      supportEmail: "support@synthetic.example",
    });
  });
});
