import { randomBytes } from "node:crypto";
import { requireSameCompany } from "../../packages/authz/src/index";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../packages/database/src/generated/prisma/client";
import { createAuth } from "../../apps/web/src/server/auth/config";
import { createCredentialUser } from "../../apps/web/src/server/auth/credentials";
import {
  createWithPolicy,
  privateJson,
} from "../../apps/web/src/server/authz/policy";
import { companyHandlers } from "../../apps/web/src/server/company/handlers";
import {
  type CommittedDatabase,
  withCommittedDatabase,
} from "../helpers/committed-database";
import { syntheticFactory } from "../helpers/factories";

const ORIGIN = "http://127.0.0.1:3000";
const PASSWORD = "correct horse battery staple";
let database: CommittedDatabase;
let db: PrismaClient;
let auth: ReturnType<typeof createAuth>;
let withPolicy: ReturnType<typeof createWithPolicy>;
let handlers: ReturnType<typeof companyHandlers>;
const factory = syntheticFactory(0x1414);
const ids = {} as Record<
  "owner" | "employee" | "outsider" | "lonely" | "companyA" | "companyB",
  string
>;
const cookies = {} as Record<
  "owner" | "employee" | "outsider" | "lonely",
  Headers
>;
let ip = 0;

async function signIn(email: string): Promise<Headers> {
  const response = await auth.handler(
    new Request(`${ORIGIN}/api/auth/sign-in/email`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        "x-forwarded-for": `203.0.113.${(ip += 1)}`,
      },
      body: JSON.stringify({ email, password: PASSWORD }),
    }),
  );
  expect(response.status).toBe(200);
  return new Headers({
    cookie: response.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; "),
  });
}

function request(
  method: string,
  headers: Headers = new Headers(),
  body?: unknown,
  path = "/api/company",
) {
  const init: RequestInit = { method, headers: new Headers(headers) };
  if (body !== undefined) {
    (init.headers as Headers).set("content-type", "application/json");
    init.body = JSON.stringify(body);
  }
  return new Request(`${ORIGIN}${path}`, init);
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
  withPolicy = createWithPolicy({ auth: () => auth, db: () => db });
  handlers = companyHandlers(() => db);
  for (const key of ["owner", "employee", "outsider", "lonely"] as const) {
    ids[key] = (
      await createCredentialUser(db, {
        email: `${key}@jobflow.invalid`,
        name: `Synthetic ${key}`,
        password: PASSWORD,
      })
    ).id;
  }
  for (const [key, owner] of [
    ["companyA", ids.owner],
    ["companyB", ids.outsider],
  ] as const) {
    const company = factory.company(owner);
    await db.$transaction(async (tx) => {
      await tx.company.create({ data: company });
      await tx.membership.create({
        data: factory.membership(company.id, owner),
      });
    });
    ids[key] = company.id;
  }
  await db.membership.create({
    data: {
      companyId: ids.companyA,
      userId: ids.employee,
      createdBy: ids.owner,
      role: "employee",
    },
  });
  for (const key of ["owner", "employee", "outsider", "lonely"] as const) {
    cookies[key] = await signIn(`${key}@jobflow.invalid`);
  }
}, 60_000);
afterAll(() => database?.release());

describe("withPolicy", () => {
  it("returns 401 to signed-out requests, without caching", async () => {
    const response = await withPolicy("company.read", handlers.read)(
      request("GET"),
      undefined,
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("returns 403 to a signed-in user without an active company", async () => {
    const response = await withPolicy("company.read", handlers.read)(
      request("GET", cookies.lonely),
      undefined,
    );
    expect(response.status).toBe(403);
  });

  it("returns 403 when the role lacks the permission", async () => {
    const response = await withPolicy("company.update", handlers.rename)(
      request("PATCH", cookies.employee, { name: "Sample Takeover" }),
      undefined,
    );
    expect(response.status).toBe(403);
    expect(
      (await db.company.findUniqueOrThrow({ where: { id: ids.companyA } }))
        .name,
    ).not.toBe("Sample Takeover");
  });

  it("lets any member read their company, returning only allowlisted fields", async () => {
    const response = await withPolicy("company.read", handlers.read)(
      request("GET", cookies.employee),
      undefined,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      id: ids.companyA,
      name: "Synthetic Test Company",
      isDemo: true,
    });
  });
});

describe("company scope", () => {
  it("ignores a forged companyId: the owner can only rename their own company, with an audit event", async () => {
    const response = await withPolicy("company.update", handlers.rename)(
      request("PATCH", cookies.owner, {
        name: "Sample Renamed Co",
        companyId: ids.companyB,
      }),
      undefined,
    );
    expect(response.status).toBe(200);
    expect((await response.json()).id).toBe(ids.companyA);
    expect(
      (await db.company.findUniqueOrThrow({ where: { id: ids.companyA } }))
        .name,
    ).toBe("Sample Renamed Co");
    expect(
      (await db.company.findUniqueOrThrow({ where: { id: ids.companyB } }))
        .name,
    ).toBe("Synthetic Test Company");
    const event = await db.auditEvent.findFirst({
      where: { companyId: ids.companyA, action: "company.renamed" },
    });
    expect(event?.createdBy).toBe(ids.owner);
    expect(event?.metadata).toMatchObject({
      changes: { name: { after: "Sample Renamed Co" } },
    });
  });

  it("rejects invalid input with 400", async () => {
    for (const body of [
      {},
      { name: "" },
      { name: "x".repeat(201) },
      "not json",
    ]) {
      const response = await withPolicy("company.update", handlers.rename)(
        request("PATCH", cookies.owner, body),
        undefined,
      );
      expect(response.status).toBe(400);
    }
  });

  it("reports another company's record id as not found (404), like a missing one", async () => {
    const byId = withPolicy("company.read", async ({ actor, request: req }) => {
      const id = new URL(req.url).searchParams.get("id") ?? "";
      const membership = requireSameCompany(
        actor,
        await db.membership.findUnique({ where: { id } }),
      );
      return privateJson({ id: membership.id });
    });
    const get = (id: string) =>
      byId(
        request("GET", cookies.owner, undefined, `/api/memberships?id=${id}`),
        undefined,
      );
    const own = await db.membership.findFirstOrThrow({
      where: { companyId: ids.companyA },
    });
    const other = await db.membership.findFirstOrThrow({
      where: { companyId: ids.companyB },
    });
    expect((await get(own.id)).status).toBe(200);
    expect((await get(other.id)).status).toBe(404);
    expect((await get("00000000-0000-4000-8000-000000000000")).status).toBe(
      404,
    );
  });
});
