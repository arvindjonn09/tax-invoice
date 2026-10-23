import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../packages/database/src/generated/prisma/client";
import { createAuth } from "../../apps/web/src/server/auth/config";
import { createCredentialUser } from "../../apps/web/src/server/auth/credentials";
import {
  resolveActor,
  setActiveCompany,
} from "../../apps/web/src/server/auth/actor";
import { createWithPolicy } from "../../apps/web/src/server/authz/policy";
import {
  acceptInvitation,
  userHandlers,
} from "../../apps/web/src/server/users/handlers";
import {
  withCommittedDatabase,
  type CommittedDatabase,
} from "../helpers/committed-database";
import { syntheticFactory } from "../helpers/factories";

const ORIGIN = "http://127.0.0.1:3000";
const PASSWORD = "synthetic password for tests";
const ROLES = [
  "owner",
  "manager",
  "accountant",
  "employee",
  "subcontractor",
] as const;
type Who = (typeof ROLES)[number] | "outsider" | "secondOwner";
let database: CommittedDatabase;
let db: PrismaClient;
let auth: ReturnType<typeof createAuth>;
let withPolicy: ReturnType<typeof createWithPolicy>;
let handlers: ReturnType<typeof userHandlers>;
let accept: ReturnType<typeof acceptInvitation>;
let companyId: string;
let otherCompanyId: string;
const userIds = {} as Record<Who, string>;
const memberIds = {} as Record<Who, string>;
const cookies = {} as Record<Who, Headers>;
let ip = 0;
const factory = syntheticFactory(0x2727);

function signIn(email: string) {
  return auth.handler(
    new Request(`${ORIGIN}/api/auth/sign-in/email`, {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        "x-forwarded-for": `198.51.100.${++ip}`,
      },
      body: JSON.stringify({ email, password: PASSWORD }),
    }),
  );
}
const headersFrom = (response: Response) =>
  new Headers({
    cookie: response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; "),
  });
function request(who: Who | null, method: string, body?: unknown, query = "") {
  const headers = new Headers(who ? cookies[who] : undefined);
  headers.set("origin", ORIGIN);
  headers.set("content-type", "application/json");
  headers.set("x-forwarded-for", `203.0.113.${++ip}`);
  return new Request(`${ORIGIN}/api/users${query}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const context = (id: string) => ({ params: Promise.resolve({ id }) });
const api = () => ({
  list: withPolicy("user.manage", handlers.list),
  invite: withPolicy("user.manage", handlers.invite),
  update: withPolicy("user.manage", handlers.update),
  revoke: withPolicy("user.manage", handlers.revoke),
});
async function invitation(email: string, role = "employee") {
  const response = await api().invite(
    request("owner", "POST", { email, role }),
    undefined,
  );
  expect(response.status).toBe(201);
  const result = (await response.json()) as {
    invitation: { id: string };
    invitationPath: string;
  };
  return {
    id: result.invitation.id,
    token: result.invitationPath.split("#")[1]!,
  };
}

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
  handlers = userHandlers(() => db);
  accept = acceptInvitation({
    auth: () => auth,
    db: () => db,
    trustedOrigins: () => [ORIGIN],
  });
  for (const who of [...ROLES, "outsider", "secondOwner"] as const) {
    userIds[who] = (
      await createCredentialUser(db, {
        email: `${who.toLowerCase()}@jobflow.invalid`,
        name: `Synthetic ${who}`,
        password: PASSWORD,
      })
    ).id;
  }
  for (const who of ["owner", "outsider"] as const) {
    const company = factory.company(userIds[who]);
    await db.$transaction(async (tx) => {
      await tx.company.create({ data: company });
      const membership = await tx.membership.create({
        data: factory.membership(company.id, userIds[who]),
      });
      memberIds[who] = membership.id;
    });
    if (who === "owner") companyId = company.id;
    else otherCompanyId = company.id;
  }
  for (const who of [...ROLES.slice(1), "secondOwner"] as const) {
    memberIds[who] = (
      await db.membership.create({
        data: {
          companyId,
          userId: userIds[who],
          createdBy: userIds.owner,
          role: who === "secondOwner" ? "employee" : who,
        },
      })
    ).id;
  }
  for (const who of [...ROLES, "outsider", "secondOwner"] as const) {
    const response = await signIn(`${who.toLowerCase()}@jobflow.invalid`);
    expect(response.status).toBe(200);
    cookies[who] = headersFrom(response);
  }
}, 90_000);
afterAll(() => database?.release());

describe("owner user access", () => {
  it("requires owner on every endpoint, including reads; anonymous and other roles cannot act", async () => {
    for (const who of [
      null,
      "manager",
      "accountant",
      "employee",
      "subcontractor",
    ] as const) {
      const status = who === null ? 401 : 403;
      expect((await api().list(request(who, "GET"), undefined)).status).toBe(
        status,
      );
      expect(
        (
          await api().invite(
            request(who, "POST", {
              email: "denied@jobflow.invalid",
              role: "owner",
            }),
            undefined,
          )
        ).status,
      ).toBe(status);
      expect(
        (
          await api().update(
            request(who, "PATCH", { role: "owner" }),
            context(memberIds.employee),
          )
        ).status,
      ).toBe(status);
      expect(
        (
          await api().revoke(
            request(who, "DELETE"),
            context(crypto.randomUUID()),
          )
        ).status,
      ).toBe(status);
    }
    expect(await db.userInvitation.count()).toBe(0);
  });

  it("lists only the active company's memberships, with bounded search and no secrets", async () => {
    const response = await api().list(
      request("owner", "GET", undefined, "?pageSize=999&q=employee"),
      undefined,
    );
    const result = await response.json();
    expect(result).toMatchObject({ pageSize: 100, total: 1 });
    expect(result.members[0]).toMatchObject({ id: memberIds.employee });
    expect(Object.keys(result.members[0]).sort()).toEqual([
      "id",
      "isActive",
      "role",
      "user",
      "userId",
    ]);
    expect(Object.keys(result.members[0].user).sort()).toEqual([
      "email",
      "name",
    ]);
    expect(JSON.stringify(result)).not.toContain("password");
    const outsider = await (
      await api().list(request("outsider", "GET"), undefined)
    ).json();
    expect(outsider.members.map((m: { id: string }) => m.id)).toEqual([
      memberIds.outsider,
    ]);
    expect(
      (
        await api().update(
          request("owner", "PATCH", { role: "manager" }),
          context(memberIds.outsider),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await api().update(
          request("owner", "PATCH", { role: "manager" }),
          context("bad"),
        )
      ).status,
    ).toBe(404);
  });

  it("validates role/status updates, protects CSRF and never accepts a client-selected company", async () => {
    expect(
      (
        await api().update(
          request("owner", "PATCH", { role: "admin" }),
          context(memberIds.employee),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await api().update(
          request("owner", "PATCH", {}),
          context(memberIds.employee),
        )
      ).status,
    ).toBe(400);
    const forged = request("owner", "PATCH", { role: "manager" });
    forged.headers.set("origin", "https://attacker.invalid");
    expect(
      (await api().update(forged, context(memberIds.employee))).status,
    ).toBe(403);
    const response = await api().update(
      request("owner", "PATCH", { role: "manager", companyId: otherCompanyId }),
      context(memberIds.employee),
    );
    expect(response.status).toBe(200);
    const row = await db.membership.findUniqueOrThrow({
      where: { id: memberIds.employee },
    });
    expect(row).toMatchObject({ companyId, role: "manager" });
    const event = await db.auditEvent.findFirstOrThrow({
      where: { action: "membership.access_updated", targetId: row.id },
    });
    expect(event.metadata).toMatchObject({
      changes: { role: { before: "employee", after: "manager" } },
    });
    expect(await resolveActor(auth, db, cookies.employee)).toMatchObject({
      actor: { role: "manager" },
    });
    await api().update(
      request("owner", "PATCH", { role: "employee" }),
      context(memberIds.employee),
    );
  });

  it("does not remove or demote the last active owner and leaves no audit on failure", async () => {
    const before = await db.auditEvent.count();
    for (const body of [
      { isActive: false },
      { role: "employee" },
      { role: "owner", isActive: false },
    ]) {
      expect(
        (
          await api().update(
            request("owner", "PATCH", body),
            context(memberIds.owner),
          )
        ).status,
      ).toBe(409);
    }
    expect(await db.auditEvent.count()).toBe(before);
    expect(
      await db.membership.count({
        where: { companyId, role: "owner", isActive: true },
      }),
    ).toBe(1);
  });

  it("serializes simultaneous owner demotions, preserving at least one active owner", async () => {
    await api().update(
      request("owner", "PATCH", { role: "owner" }),
      context(memberIds.secondOwner),
    );
    const responses = await Promise.all([
      api().update(
        request("owner", "PATCH", { role: "employee" }),
        context(memberIds.owner),
      ),
      api().update(
        request("secondOwner", "PATCH", { role: "employee" }),
        context(memberIds.secondOwner),
      ),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    const remaining = await db.membership.findFirstOrThrow({
      where: { companyId, role: "owner", isActive: true },
    });
    const who = remaining.userId === userIds.owner ? "owner" : "secondOwner";
    await api().update(
      request(who, "PATCH", { role: "owner" }),
      context(memberIds.owner),
    );
    await api().update(
      request("owner", "PATCH", { role: "employee" }),
      context(memberIds.secondOwner),
    );
  });

  it("deactivates without deleting history, revokes the session and refuses new sign-in", async () => {
    expect(
      (
        await api().update(
          request("owner", "PATCH", { isActive: false }),
          context(memberIds.employee),
        )
      ).status,
    ).toBe(200);
    expect(
      await db.membership.count({
        where: { id: memberIds.employee, isActive: false },
      }),
    ).toBe(1);
    expect(await auth.api.getSession({ headers: cookies.employee })).toBeNull();
    expect((await signIn("employee@jobflow.invalid")).status).toBe(403);
    expect(
      await db.authSession.count({ where: { userId: userIds.employee } }),
    ).toBe(0);
    await api().update(
      request("owner", "PATCH", { isActive: true }),
      context(memberIds.employee),
    );
    const restored = await signIn("employee@jobflow.invalid");
    expect(restored.status).toBe(200);
    cookies.employee = headersFrom(restored);
  });

  it("keeps unrelated company access active when a multi-company member is deactivated", async () => {
    const member = await db.membership.create({
      data: {
        companyId,
        userId: userIds.outsider,
        createdBy: userIds.owner,
        role: "employee",
      },
    });
    expect(
      await setActiveCompany(auth, db, cookies.outsider, otherCompanyId),
    ).toBe(true);
    await api().update(
      request("owner", "PATCH", { isActive: false }),
      context(member.id),
    );
    expect(await resolveActor(auth, db, cookies.outsider)).toMatchObject({
      actor: { companyId: otherCompanyId, role: "owner" },
    });
    expect((await signIn("outsider@jobflow.invalid")).status).toBe(200);
  });
});

describe("invitations", () => {
  it("issues a hashed, expiring link, audits safely, blocks duplicates and hides tokens on lists", async () => {
    const issued = await invitation("new@jobflow.invalid", "manager");
    const row = await db.userInvitation.findUniqueOrThrow({
      where: { id: issued.id },
    });
    expect(row.tokenHash).not.toBe(issued.token);
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBeGreaterThan(
      47 * 60 * 60 * 1000,
    );
    const event = await db.auditEvent.findFirstOrThrow({
      where: { targetId: issued.id },
    });
    expect(JSON.stringify(event.metadata)).not.toContain(issued.token);
    expect(JSON.stringify(event.metadata)).not.toContain(row.email);
    const list = await api().list(request("owner", "GET"), undefined);
    expect(await list.text()).not.toContain(row.tokenHash);
    expect(
      (
        await api().invite(
          request("owner", "POST", { email: row.email, role: "manager" }),
          undefined,
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await api().invite(
          request("owner", "POST", {
            email: "employee@jobflow.invalid",
            role: "manager",
          }),
          undefined,
        )
      ).status,
    ).toBe(409);
    expect(
      (await api().revoke(request("outsider", "DELETE"), context(issued.id)))
        .status,
    ).toBe(404);
  });

  it("accepts a new user's invite once, grants exactly its role/company and hashes their password", async () => {
    const issued = await invitation("joining@jobflow.invalid", "accountant");
    const response = await accept(
      request(null, "POST", {
        token: issued.token,
        name: "Synthetic Joiner",
        password: PASSWORD,
        role: "owner",
        companyId: otherCompanyId,
      }),
    );
    expect(response.status).toBe(200);
    const user = await db.user.findUniqueOrThrow({
      where: { email: "joining@jobflow.invalid" },
    });
    expect(
      await db.membership.findUnique({
        where: { companyId_userId: { companyId, userId: user.id } },
      }),
    ).toMatchObject({ role: "accountant", isActive: true });
    const credential = await db.authAccount.findFirstOrThrow({
      where: { userId: user.id },
    });
    expect(credential.password).not.toBe(PASSWORD);
    expect(
      (
        await accept(
          request(null, "POST", {
            token: issued.token,
            name: "Again",
            password: PASSWORD,
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      await db.auditEvent.count({
        where: { action: "invitation.accepted", targetId: issued.id },
      }),
    ).toBe(1);
    expect((await signIn("joining@jobflow.invalid")).status).toBe(200);
  });

  it("serializes simultaneous redemption so it grants one membership and one acceptance event", async () => {
    const issued = await invitation("race@jobflow.invalid");
    const responses = await Promise.all(
      Array.from({ length: 2 }, () =>
        accept(
          request(null, "POST", {
            token: issued.token,
            name: "Race Sample",
            password: PASSWORD,
          }),
        ),
      ),
    );
    expect(responses.map((r) => r.status).sort()).toEqual([200, 400]);
    expect(
      await db.membership.count({
        where: { companyId, user: { email: "race@jobflow.invalid" } },
      }),
    ).toBe(1);
    expect(
      await db.auditEvent.count({
        where: { action: "invitation.accepted", targetId: issued.id },
      }),
    ).toBe(1);
  });

  it("requires a matching authenticated account for existing email, without resetting its credentials", async () => {
    const existing = await createCredentialUser(db, {
      email: "existing@jobflow.invalid",
      name: "Existing Sample",
      password: PASSWORD,
    });
    const issued = await invitation(existing.email);
    expect(
      (
        await accept(
          request(null, "POST", {
            token: issued.token,
            name: "Takeover",
            password: PASSWORD,
          }),
        )
      ).status,
    ).toBe(401);
    expect(
      (await accept(request("owner", "POST", { token: issued.token }))).status,
    ).toBe(401);
    const before = await db.authAccount.findFirstOrThrow({
      where: { userId: existing.id },
    });
    const signedIn = headersFrom(await signIn(existing.email));
    const incoming = request(null, "POST", {
      token: issued.token,
      password: "a different password",
    });
    incoming.headers.set("cookie", signedIn.get("cookie") ?? "");
    expect((await accept(incoming)).status).toBe(200);
    expect(
      (
        await db.authAccount.findFirstOrThrow({
          where: { userId: existing.id },
        })
      ).password,
    ).toBe(before.password);
  });

  it("rejects expired, revoked, invalid and disabled-inviter tokens without creating accounts", async () => {
    const expired = await invitation("expired@jobflow.invalid");
    await db.userInvitation.update({
      where: { id: expired.id },
      data: {
        createdAt: new Date(Date.now() - 10000),
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    const revoked = await invitation("revoked@jobflow.invalid");
    expect(
      (await api().revoke(request("owner", "DELETE"), context(revoked.id)))
        .status,
    ).toBe(200);
    for (const token of [
      expired.token,
      revoked.token,
      randomBytes(32).toString("hex"),
    ]) {
      expect(
        (
          await accept(
            request(null, "POST", {
              token,
              name: "No Account",
              password: PASSWORD,
            }),
          )
        ).status,
      ).toBe(400);
    }
    expect(
      await db.user.count({
        where: {
          email: { in: ["expired@jobflow.invalid", "revoked@jobflow.invalid"] },
        },
      }),
    ).toBe(0);
    const reissued = await invitation("expired@jobflow.invalid");
    expect(reissued.token).not.toBe(expired.token);
    expect(
      (await db.userInvitation.findUniqueOrThrow({ where: { id: expired.id } }))
        .revokedAt,
    ).not.toBeNull();
    // Revoke inviter permissions before redemption; a former owner's grant is refused.
    await api().update(
      request("owner", "PATCH", { role: "owner" }),
      context(memberIds.secondOwner),
    );
    const issued = await api().invite(
      request("secondOwner", "POST", {
        email: "former-owner-invite@jobflow.invalid",
        role: "owner",
      }),
      undefined,
    );
    const token = (await issued.json()).invitationPath.split("#")[1];
    await api().update(
      request("owner", "PATCH", { role: "employee" }),
      context(memberIds.secondOwner),
    );
    expect(
      (
        await accept(
          request(null, "POST", {
            token,
            name: "No Grant",
            password: PASSWORD,
          }),
        )
      ).status,
    ).toBe(400);
  });

  it("enforces CSRF, bounded bodies, input validation and shared acceptance throttling", async () => {
    const crossOrigin = request(null, "POST", { token: "bad" });
    crossOrigin.headers.set("origin", "https://attacker.invalid");
    expect((await accept(crossOrigin)).status).toBe(403);
    expect(
      (
        await accept(
          request(null, "POST", { token: "bad", padding: "x".repeat(5000) }),
        )
      ).status,
    ).toBe(413);
    expect((await accept(request(null, "POST", { token: "bad" }))).status).toBe(
      400,
    );
    const statuses = [];
    for (let index = 0; index < 21; index += 1) {
      const incoming = request(null, "POST", { token: "bad" });
      incoming.headers.set("x-forwarded-for", "192.0.2.200");
      statuses.push((await accept(incoming)).status);
    }
    expect(statuses.at(-1)).toBe(429);
  });
});
