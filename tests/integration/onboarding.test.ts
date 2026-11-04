import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../packages/database/src/generated/prisma/client";
import { resolveActor } from "../../apps/web/src/server/auth/actor";
import { createAuth } from "../../apps/web/src/server/auth/config";
import { createCredentialUser } from "../../apps/web/src/server/auth/credentials";
import {
  createCompany,
  selectCompany,
} from "../../apps/web/src/server/onboarding/handlers";
import {
  type CommittedDatabase,
  withCommittedDatabase,
} from "../helpers/committed-database";

// #220 (S5): a verified user creates their company, becoming Owner, with a trial.
const ORIGIN = "http://127.0.0.1:3000";
const SECRET = randomBytes(32).toString("hex");
const PASSWORD = "correct horse battery staple";
// 10:00 on 3 Nov 2026 in Sydney.
const NOW = new Date("2026-11-02T23:00:00Z");
let database: CommittedDatabase;
let db: PrismaClient;
let auth: ReturnType<typeof createAuth>;
let handler: ReturnType<typeof createCompany>;
let ipCounter = 0;

beforeAll(async () => {
  database = await withCommittedDatabase();
  db = database.client;
  auth = createAuth({ db, secret: SECRET, baseURL: ORIGIN, production: false });
  handler = createCompany({
    db: () => db,
    auth: () => auth,
    trustedOrigins: () => [ORIGIN],
    now: () => NOW,
  });
}, 60_000);
afterAll(() => database?.release());

async function session(email: string, verified = true): Promise<Headers> {
  const user = await createCredentialUser(db, {
    email,
    name: "Onboarding Owner",
    password: PASSWORD,
  });
  if (verified) {
    await db.user.update({
      where: { id: user.id },
      data: { emailVerified: true },
    });
  }
  const response = await auth.handler(
    new Request(`${ORIGIN}/api/auth/sign-in/email`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        "x-forwarded-for": `198.51.100.${(ipCounter += 1)}`,
      },
      body: JSON.stringify({ email, password: PASSWORD }),
    }),
  );
  expect(response.status).toBe(200);
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  return new Headers({ cookie });
}

function post(cookies: Headers, body: unknown, key = "key-0001-abcdef") {
  const text = JSON.stringify(body);
  const headers = new Headers(cookies);
  headers.set("origin", ORIGIN);
  headers.set("content-type", "application/json");
  headers.set("content-length", String(Buffer.byteLength(text)));
  headers.set("idempotency-key", key);
  return new Request(`${ORIGIN}/api/onboarding/company`, {
    method: "POST",
    headers,
    body: text,
  });
}

const registered = {
  businessName: "Sparks Electrical",
  legalName: "Sparks Electrical Pty Ltd",
  gstRegistered: true,
  abn: "51 824 753 556",
  gstStartsOn: "2024-07-01",
  gstBasis: "cash",
  basPeriod: "quarterly",
  addressLine1: "1 Sample Street",
  suburb: "Parramatta",
  state: "NSW",
  postcode: "2150",
};

describe("onboarding", () => {
  it("creates the company, owner membership, GST registration and 30-day trial together", async () => {
    // Real email domain so the reserved-domain test exemption doesn't apply.
    const cookies = await session("owner-one@example.com");
    const response = await handler(post(cookies, registered));
    expect(response.status).toBe(201);
    const { companyId } = (await response.json()) as { companyId: string };
    const company = await db.company.findUniqueOrThrow({
      where: { id: companyId },
      include: { memberships: true, gstRegistrations: true },
    });
    expect(company).toMatchObject({
      name: "Sparks Electrical",
      legalName: "Sparks Electrical Pty Ltd",
      abn: "51824753556",
      state: "NSW",
      isDemo: false,
      accessMode: "trial",
    });
    expect(company.trialLastDay?.toISOString().slice(0, 10)).toBe("2026-12-02");
    // Read-only from midnight Sydney after 2 Dec (AEDT).
    expect(company.readOnlyFrom?.toISOString()).toBe(
      "2026-12-02T13:00:00.000Z",
    );
    expect(company.memberships).toMatchObject([
      { role: "owner", isActive: true },
    ]);
    expect(company.gstRegistrations).toMatchObject([{ basis: "cash" }]);
    const actions = (
      await db.auditEvent.findMany({
        where: { companyId },
        orderBy: { createdAt: "asc" },
      })
    ).map((event) => event.action);
    expect(actions).toEqual([
      "company.created",
      "gst_settings.registration_added",
      "trial.started",
    ]);
    // The session now acts in the new company as its Owner.
    const resolution = await resolveActor(auth, db, cookies);
    expect(resolution).toMatchObject({
      status: "active",
      actor: { companyId, role: "owner" },
    });
  });

  it("returns the same company for a retry and refuses a second company", async () => {
    const cookies = await session("owner-two@example.com");
    const body = { businessName: "Two Trades", gstRegistered: false };
    const [first, second] = await Promise.all([
      handler(post(cookies, body, "retry-key-0002")),
      handler(post(cookies, body, "retry-key-0002")),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 201]);
    const ids = new Set([
      ((await first.json()) as { companyId: string }).companyId,
      ((await second.json()) as { companyId: string }).companyId,
    ]);
    expect(ids.size).toBe(1);
    const another = await handler(post(cookies, body, "different-key-0003"));
    expect(another.status).toBe(409);
    expect((await another.json()).code).toBe("self_service_limit");
  });

  it("validates GST details and refuses extra fields", async () => {
    const cookies = await session("owner-three@example.com");
    const missing = await handler(
      post(cookies, { businessName: "Three", gstRegistered: true }),
    );
    expect(Object.keys((await missing.json()).fields).sort()).toEqual([
      "abn",
      "gstBasis",
      "gstStartsOn",
    ]);
    const badAbn = await handler(
      post(cookies, {
        businessName: "Three",
        gstRegistered: false,
        abn: "12345678901",
      }),
    );
    expect((await badAbn.json()).fields.abn).toMatch(/valid 11-digit ABN/);
    for (const extra of [
      { companyId: "x" },
      { isDemo: true },
      { role: "owner" },
      { accessMode: "unrestricted" },
    ]) {
      const response = await handler(
        post(cookies, {
          businessName: "Three",
          gstRegistered: false,
          ...extra,
        }),
      );
      expect(response.status).toBe(400);
    }
    expect(await db.company.count({ where: { name: "Three" } })).toBe(0);
  });

  it("requires a verified session from the app's own origin", async () => {
    const unverified = await session("owner-four@example.com", false);
    expect(
      (
        await handler(
          post(unverified, { businessName: "Four", gstRegistered: false }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await handler(
          post(new Headers(), { businessName: "Four", gstRegistered: false }),
        )
      ).status,
    ).toBe(401);
    const verified = await session("owner-five@example.com");
    const forged = post(verified, {
      businessName: "Five",
      gstRegistered: false,
    });
    forged.headers.set("origin", "https://evil.example");
    expect((await handler(forged)).status).toBe(403);
    const keyless = post(verified, {
      businessName: "Five",
      gstRegistered: false,
    });
    keyless.headers.delete("idempotency-key");
    expect((await handler(keyless)).status).toBe(400);
  });
});

describe("choosing a company (S12)", () => {
  function choose(cookies: Headers, companyId: string) {
    const body = JSON.stringify({ companyId });
    const headers = new Headers(cookies);
    headers.set("origin", ORIGIN);
    headers.set("content-type", "application/json");
    headers.set("content-length", String(Buffer.byteLength(body)));
    return selectCompany({
      db: () => db,
      auth: () => auth,
      trustedOrigins: () => [ORIGIN],
    })(
      new Request(`${ORIGIN}/api/session/company`, {
        method: "POST",
        headers,
        body,
      }),
    );
  }

  it("lets a member of two companies pick either, and nothing else", async () => {
    const email = "two-companies@example.com";
    const first = await session(email);
    const created = await handler(
      post(
        first,
        { businessName: "Mine", gstRegistered: false },
        "two-key-001",
      ),
    );
    const { companyId: mine } = (await created.json()) as { companyId: string };
    const other = await session("other-owner@example.com");
    const made = await handler(
      post(
        other,
        { businessName: "Theirs", gstRegistered: false },
        "two-key-002",
      ),
    );
    const { companyId: theirs } = (await made.json()) as { companyId: string };
    const stranger = await session("stranger-owner@example.com");
    const strangers = await handler(
      post(
        stranger,
        { businessName: "Else", gstRegistered: false },
        "two-key-003",
      ),
    );
    const { companyId: elsewhere } = (await strangers.json()) as {
      companyId: string;
    };
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    const owner = await db.user.findUniqueOrThrow({
      where: { email: "other-owner@example.com" },
    });
    await db.membership.create({
      data: {
        companyId: theirs,
        userId: user.id,
        role: "employee",
        createdBy: owner.id,
      },
    });
    // A new session has no remembered company: the user must choose.
    const response = await auth.handler(
      new Request(`${ORIGIN}/api/auth/sign-in/email`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: ORIGIN,
          "x-forwarded-for": `198.51.100.${(ipCounter += 1)}`,
        },
        body: JSON.stringify({ email, password: PASSWORD }),
      }),
    );
    const fresh = new Headers({
      cookie: response.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; "),
    });
    expect((await resolveActor(auth, db, fresh)).status).toBe("choose-company");
    expect((await choose(fresh, elsewhere)).status).toBe(404);
    expect((await resolveActor(auth, db, fresh)).status).toBe("choose-company");
    expect((await choose(fresh, theirs)).status).toBe(204);
    expect(await resolveActor(auth, db, fresh)).toMatchObject({
      status: "active",
      actor: { companyId: theirs, role: "employee" },
    });
    expect((await choose(fresh, mine)).status).toBe(204);
    expect(await resolveActor(auth, db, fresh)).toMatchObject({
      actor: { companyId: mine, role: "owner" },
    });
    expect((await choose(new Headers(), mine)).status).toBe(401);
  });
});
