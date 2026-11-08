import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../packages/database/src/generated/prisma/client";
import {
  READ_ONLY_EXEMPTION_ACTIONS,
  withAudit,
} from "../../packages/database/src/index";
import { createAuth } from "../../apps/web/src/server/auth/config";
import { createCredentialUser } from "../../apps/web/src/server/auth/credentials";
import { createWithPolicy } from "../../apps/web/src/server/authz/policy";
import {
  READ_ONLY_ALLOWED,
  UNSAFE_METHODS,
} from "../../apps/web/src/server/authz/read-only";
import {
  acceptInvitation,
  userHandlers,
} from "../../apps/web/src/server/users/handlers";
import type { Permission } from "../../packages/authz/src/index";
import { routeEntries } from "../helpers/route-matrix";
import {
  type CommittedDatabase,
  withCommittedDatabase,
} from "../helpers/committed-database";
import { syntheticFactory } from "../helpers/factories";
import { operatorUpdate, operatorUpdateInTx } from "../helpers/operator-update";

// #222: the route-level read-only guard (ADR 0004 D4), its allowlist and the
// handlers' exemption keys, over the #211 commit-time database guard.
const ORIGIN = "http://127.0.0.1:3000";
const PASSWORD = "synthetic password for tests";
let database: CommittedDatabase;
let db: PrismaClient;
let auth: ReturnType<typeof createAuth>;
let withPolicy: ReturnType<typeof createWithPolicy>;
let users: ReturnType<typeof userHandlers>;
let accept: ReturnType<typeof acceptInvitation>;
let companyId = "";
const ids: Record<string, string> = {};
let ownerCookie = new Headers();
let ip = 0;
const factory = syntheticFactory(0x2220);

function request(
  method: string,
  path: string,
  body?: unknown,
  cookie = ownerCookie,
) {
  const headers = new Headers(cookie);
  headers.set("origin", ORIGIN);
  headers.set("content-type", "application/json");
  headers.set("x-forwarded-for", `203.0.113.${(++ip % 250) + 1}`);
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const context = (id: string) => ({ params: Promise.resolve({ id }) });

async function signIn(email: string) {
  const response = await auth.handler(
    new Request(`${ORIGIN}/api/auth/sign-in/email`, {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        "x-forwarded-for": `198.51.100.${(++ip % 250) + 1}`,
      },
      body: JSON.stringify({ email, password: PASSWORD }),
    }),
  );
  expect(response.status).toBe(200);
  return new Headers({
    cookie: response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; "),
  });
}

function setTrial(lastDay: string | null) {
  return operatorUpdate(db, {
    where: { id: companyId },
    data:
      lastDay === null
        ? { accessMode: "unrestricted" }
        : {
            accessMode: "trial",
            trialStartedAt: new Date("2019-12-01T00:00:00Z"),
            trialLastDay: new Date(`${lastDay}T00:00:00Z`),
          },
  });
}
const expire = () => setTrial("2020-01-01");

beforeAll(async () => {
  database = await withCommittedDatabase();
  db = database.client;
  auth = createAuth({
    db,
    secret: randomBytes(32).toString("hex"),
    baseURL: ORIGIN,
    production: false,
  });
  withPolicy = createWithPolicy({
    auth: () => auth,
    db: () => db,
    trustedOrigins: () => [ORIGIN],
  });
  users = userHandlers(() => db);
  accept = acceptInvitation({
    auth: () => auth,
    db: () => db,
    trustedOrigins: () => [ORIGIN],
    appUrl: () => ORIGIN,
    emailSecret: () => "test-outbox-key-0123456789abcdef-0123456789",
    dispatch: () => {},
    defer: (work: () => Promise<void>) => work(),
  });
  for (const who of ["owner", "employee"])
    ids[who] = (
      await createCredentialUser(db, {
        email: `ro-${who}@jobflow.invalid`,
        name: `Synthetic ${who}`,
        password: PASSWORD,
      })
    ).id;
  const company = { ...factory.company(ids.owner!), isDemo: false };
  companyId = company.id;
  await db.$transaction(async (tx) => {
    await tx.company.create({ data: company });
    await tx.membership.create({
      data: factory.membership(company.id, ids.owner!),
    });
  });
  const employee = await db.membership.create({
    data: {
      ...factory.membership(companyId, ids.employee!),
      role: "employee",
      createdBy: ids.owner!,
    },
  });
  ids.employeeMembership = employee.id;
  ownerCookie = await signIn("ro-owner@jobflow.invalid");
}, 120_000);
afterAll(() => database?.release());

describe("every unsafe route through withPolicy", () => {
  // Each route's real permission, a stub handler, and a concrete path.
  const unsafe = routeEntries().filter(
    (entry) => entry.permission && UNSAFE_METHODS.has(entry.method),
  );
  const concrete = (route: string) =>
    route.replace(/\[[^\]]+\]/g, "00000000-0000-4000-8000-000000000001");
  const allowed = new Set(Object.keys(READ_ONLY_ALLOWED));

  it("covers a real set of routes", () => {
    expect(unsafe.length).toBeGreaterThan(50);
  });

  it("refuses every unsafe route of an expired company with 403 company_read_only, except the allowlist", async () => {
    await expire();
    const refused: string[] = [];
    const passed: string[] = [];
    for (const entry of unsafe) {
      let reached = false;
      const route = withPolicy(entry.permission as Permission, async () => {
        reached = true;
        return new Response(null, { status: 204 });
      });
      const response = await route(
        request(entry.method, concrete(entry.route), {}),
        context("00000000-0000-4000-8000-000000000001"),
      );
      const key = `${entry.method} ${entry.route}`;
      if (allowed.has(key)) {
        expect(response.status, key).toBe(204);
        expect(reached, key).toBe(true);
        passed.push(key);
      } else {
        expect(response.status, key).toBe(403);
        expect(await response.json(), key).toMatchObject({
          code: "company_read_only",
        });
        expect(reached, key).toBe(false);
        refused.push(key);
      }
    }
    expect(passed.sort()).toEqual([...allowed].sort());
    expect(refused.length + passed.length).toBe(unsafe.length);
  });

  it("never blocks a safe method, and lets a running trial or unrestricted company write", async () => {
    await expire();
    const route = withPolicy(
      "company.read",
      async () => new Response(null, { status: 204 }),
    );
    expect(
      (await route(request("GET", "/api/company"), undefined)).status,
    ).toBe(204);
    for (const lastDay of ["2099-12-31", null]) {
      await setTrial(lastDay);
      const write = withPolicy(
        "customer.write",
        async () => new Response(null, { status: 204 }),
      );
      expect(
        (await write(request("POST", "/api/customers", {}), undefined)).status,
      ).toBe(204);
    }
  });

  it("maps the commit-time database refusal to the same 403 (a write that raced the expiry)", async () => {
    await setTrial("2099-12-31");
    const write = withPolicy("customer.write", async ({ actor }) => {
      await withAudit(db, async (tx, audit) => {
        await audit({
          companyId: actor.companyId,
          actorUserId: actor.userId,
          action: "customer.created",
          target: { type: "customer", id: "synthetic" },
        });
        // Expiry lands before commit.
        await operatorUpdateInTx(tx, {
          where: { id: actor.companyId },
          data: { trialLastDay: new Date("2020-01-01T00:00:00Z") },
        });
      });
      return new Response(null, { status: 204 });
    });
    const response = await write(
      request("POST", "/api/customers", {}),
      undefined,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "company_read_only" });
    const company = await db.company.findUniqueOrThrow({
      where: { id: companyId },
    });
    expect(company.trialLastDay?.toISOString().slice(0, 10)).toBe("2099-12-31");
  });
});

describe("withAudit readOnlyExemption", () => {
  it("matches the SQL map key for key (TypeScript/SQL parity)", async () => {
    for (const [key, actions] of Object.entries(READ_ONLY_EXEMPTION_ACTIONS)) {
      const [row] = await db.$queryRaw<{ actions: string[] }[]>`
        SELECT jobflow_read_only_exemption_actions(${key}) AS actions`;
      expect(row!.actions, key).toEqual([...actions]);
    }
    const [unknown] = await db.$queryRaw<{ actions: string[] }[]>`
      SELECT jobflow_read_only_exemption_actions('everything') AS actions`;
    expect(unknown!.actions).toEqual([]);
  });

  it("has no SQL-only key: every key in the SQL CASE exists in TypeScript", async () => {
    const [row] = await db.$queryRaw<{ definition: string }[]>`
      SELECT pg_get_functiondef('jobflow_read_only_exemption_actions(text)'::regprocedure) AS definition`;
    const sqlKeys = [...row!.definition.matchAll(/WHEN '([a-z_]+)' THEN/g)].map(
      (match) => match[1]!,
    );
    expect(sqlKeys.sort()).toEqual(
      Object.keys(READ_ONLY_EXEMPTION_ACTIONS).sort(),
    );
  });

  it("refuses an unknown key before touching the database", async () => {
    await expect(
      withAudit(db, async () => undefined, {
        readOnlyExemption: "everything" as never,
      }),
    ).rejects.toThrow(RangeError);
  });

  it("lets an exempt action commit while read-only", async () => {
    await expire();
    await expect(
      withAudit(
        db,
        (_tx, audit) =>
          audit({
            companyId,
            actorUserId: ids.owner!,
            action: "company.exported",
            target: { type: "company", id: companyId },
          }),
        { readOnlyExemption: "export" },
      ),
    ).resolves.toBeDefined();
  });
});

describe("allowlisted user routes while read-only", () => {
  it("deactivates a member, but refuses a role change", async () => {
    await expire();
    const update = withPolicy("user.manage", users.update);
    const id = ids.employeeMembership!;
    const role = await update(
      request("PATCH", `/api/users/${id}`, { role: "manager" }),
      context(id),
    );
    expect(role.status).toBe(403);
    expect(await role.json()).toMatchObject({ code: "company_read_only" });
    const off = await update(
      request("PATCH", `/api/users/${id}`, { isActive: false }),
      context(id),
    );
    expect(off.status).toBe(200);
    const member = await db.membership.findUniqueOrThrow({ where: { id } });
    expect(member).toMatchObject({ isActive: false, role: "employee" });
  });

  it("refuses a deactivation combined with a role change, and a reactivation, at the route", async () => {
    await expire();
    const update = withPolicy("user.manage", users.update);
    const id = ids.employeeMembership!;
    for (const body of [
      { isActive: false, role: "manager" },
      { isActive: true },
    ]) {
      const response = await update(
        request("PATCH", `/api/users/${id}`, body),
        context(id),
      );
      expect(response.status, JSON.stringify(body)).toBe(403);
      expect(await response.json()).toMatchObject({
        code: "company_read_only",
      });
    }
    const member = await db.membership.findUniqueOrThrow({ where: { id } });
    expect(member).toMatchObject({ isActive: false, role: "employee" });
  });

  it("refuses new invitations, revokes old ones, and accepts only those issued before expiry", async () => {
    await setTrial(null);
    const invite = withPolicy("user.manage", users.invite);
    const issue = async (email: string) => {
      const response = await invite(
        request("POST", "/api/users/invitations", { email, role: "employee" }),
        undefined,
      );
      expect(response.status).toBe(201);
      const body = (await response.json()) as {
        invitation: { id: string };
        invitationPath: string;
      };
      return {
        id: body.invitation.id,
        token: body.invitationPath.split("#")[1]!,
      };
    };
    const early = await issue("ro-early@jobflow.invalid");
    const toRevoke = await issue("ro-revoked@jobflow.invalid");
    // Created after the trial ended (backdate the trial instead of the clock).
    const late = await issue("ro-late@jobflow.invalid");
    await operatorUpdate(db, {
      where: { id: companyId },
      data: {
        accessMode: "trial",
        trialStartedAt: new Date("2019-12-01T00:00:00Z"),
        trialLastDay: new Date("2020-01-01T00:00:00Z"),
      },
    });
    await db.$executeRaw`UPDATE user_invitations SET created_at = '2019-12-15T00:00:00Z' WHERE id IN (${early.id}::uuid, ${toRevoke.id}::uuid)`;

    const refused = await invite(
      request("POST", "/api/users/invitations", {
        email: "ro-new@jobflow.invalid",
        role: "employee",
      }),
      undefined,
    );
    expect(refused.status).toBe(403);

    const revoke = withPolicy("user.manage", users.revoke);
    expect(
      (
        await revoke(
          request("DELETE", `/api/users/invitations/${toRevoke.id}`),
          context(toRevoke.id),
        )
      ).status,
    ).toBe(200);

    const redeem = (token: string, email: string) =>
      accept(
        request(
          "POST",
          "/api/invitations/accept",
          { token, name: `Synthetic ${email}`, password: PASSWORD },
          new Headers(),
        ),
      );
    const before = await redeem(early.token, "early");
    expect(before.status).toBe(202);
    const after = await redeem(late.token, "late");
    expect(after.status).toBe(403);
    expect(await after.json()).toMatchObject({ code: "company_read_only" });
    expect(
      await db.user.count({ where: { email: "ro-late@jobflow.invalid" } }),
    ).toBe(0);
  });
});
