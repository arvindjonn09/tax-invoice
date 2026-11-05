import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { can, ROLES } from "../../packages/authz/src/index";
import type { PrismaClient } from "../../packages/database/src/generated/prisma/client";
import { withAudit } from "../../packages/database/src/index";
import { allowedWhileReadOnly } from "../../apps/web/src/server/authz/read-only";
import { exportCompany } from "../../apps/web/src/server/company/export";
import { decryptPayload } from "../../apps/web/src/server/email/crypto";
import { operatorHandlers } from "../../apps/web/src/server/operator/handlers";
import { extensionRequestHandlers } from "../../apps/web/src/server/trial/extension-requests";
import {
  type CommittedDatabase,
  withCommittedDatabase,
} from "../helpers/committed-database";
import { syntheticFactory } from "../helpers/factories";

// #231 (S14, S11 AC2, AC5, AC7): extension requests and operator decisions.
const ORIGIN = "http://127.0.0.1:3000";
const SECRET = "test-outbox-key-0123456789abcdef-0123456789";
const OPERATOR_INBOX = "operator@jobflow.invalid";
const factory = syntheticFactory(0x2310);
let database: CommittedDatabase;
let db: PrismaClient;
let operatorId = "";
let operatorEmail: string | null = OPERATOR_INBOX;
let ip = 0;

const owner = () =>
  extensionRequestHandlers({
    db: () => db,
    emailSecret: () => SECRET,
    appUrl: () => ORIGIN,
    operatorEmail: () => operatorEmail,
    dispatch: () => {},
  });
const operator = () =>
  operatorHandlers(() => ({ db, emailSecret: SECRET, appUrl: ORIGIN }));

function jsonRequest(path: string, body?: unknown) {
  return new Request(`${ORIGIN}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      "x-forwarded-for": `198.51.100.${(++ip % 250) + 1}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
type Company = { id: string; ownerId: string; ownerEmail: string };
const ask = (company: Company, body: unknown = {}) =>
  owner().create({
    actor: {
      userId: company.ownerId,
      companyId: company.id,
      role: "owner",
    },
    request: jsonRequest("/api/company/trial/extension-requests", body),
    context: undefined,
  } as never);
const viewAs = (company: Company) =>
  owner().list({
    actor: { userId: company.ownerId, companyId: company.id, role: "owner" },
    request: jsonRequest("/api/company/trial/extension-requests"),
    context: undefined,
  } as never);
const decide = (id: string, action: "approve" | "decline", body: unknown) =>
  operator()[action]({
    operatorUserId: operatorId,
    request: jsonRequest(
      `/api/operator/extension-requests/${id}/${action}`,
      body,
    ),
    context: { params: Promise.resolve({ id }) },
  });
const list = (query = "") =>
  operator().listRequests({
    operatorUserId: operatorId,
    request: jsonRequest(`/api/operator/extension-requests${query}`),
    context: undefined,
  });

async function newUser(verified = true) {
  return db.user.create({
    data: {
      ...factory.user(),
      email: `ext-${randomUUID()}@jobflow.invalid`,
      name: "Synthetic Owner",
      emailVerified: verified,
    },
  });
}
async function newCompany(
  options: {
    lastDay?: string;
    mode?: "trial" | "unrestricted";
    demo?: boolean;
  } = {},
): Promise<Company> {
  const user = await newUser();
  const mode = options.demo ? "unrestricted" : (options.mode ?? "trial");
  const company = {
    ...factory.company(user.id),
    isDemo: Boolean(options.demo),
    accessMode: mode,
    ...(mode === "trial"
      ? {
          trialStartedAt: new Date("2026-10-01T00:00:00Z"),
          trialLastDay: new Date(
            `${options.lastDay ?? "2099-01-01"}T00:00:00Z`,
          ),
        }
      : {}),
  };
  await db.$transaction(async (tx) => {
    await tx.company.create({ data: company });
    await tx.membership.create({
      data: factory.membership(company.id, user.id),
    });
  });
  return { id: company.id, ownerId: user.id, ownerEmail: user.email };
}
async function pendingFor(company: Company) {
  const response = await ask(company);
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
}
const lastDayOf = async (id: string) =>
  (await db.company.findUniqueOrThrow({ where: { id } })).trialLastDay
    ?.toISOString()
    .slice(0, 10);

beforeAll(async () => {
  database = await withCommittedDatabase();
  db = database.client;
  const user = await newUser();
  operatorId = user.id;
  await db.platformOperator.create({
    data: { userId: user.id, grantedReason: "Synthetic", grantedBy: "test" },
  });
}, 60_000);
afterAll(() => database?.release());

describe("an owner asks for more time", () => {
  it("is limited to owners, and allowed while read-only", () => {
    expect(
      ROLES.filter((role) => can(role, "trial.request_extension")),
    ).toEqual(["owner"]);
    expect(
      allowedWhileReadOnly("POST", "/api/company/trial/extension-requests"),
    ).toBe(true);
  });

  it("records one pending request, an audit event and a safe operator email", async () => {
    const company = await newCompany();
    const response = await ask(company, {
      message: "Please\r\nSubject: extra\u0007 line",
    });
    expect(response.status).toBe(201);
    const { id } = (await response.json()) as { id: string };
    const row = await db.trialExtensionRequest.findUniqueOrThrow({
      where: { id },
    });
    expect(row).toMatchObject({
      status: "pending",
      companyId: company.id,
      requestedBy: company.ownerId,
    });
    const [event] = await db.auditEvent.findMany({
      where: { companyId: company.id, action: "trial_extension.requested" },
    });
    expect(event).toMatchObject({
      actorKind: "member",
      createdBy: company.ownerId,
    });
    expect(JSON.stringify(event!.metadata)).not.toContain("Please");
    const [email] = await db.emailOutbox.findMany({
      where: { companyId: company.id, kind: "trial_extension_request" },
    });
    const message = decryptPayload(SECRET, email!.payloadCiphertext!);
    expect(message.to).toBe(OPERATOR_INBOX);
    expect(message.text).toContain(`Request: ${id}`);
    expect(message.text).toContain("Last trial day: 2099-01-01");
    expect(message.text).toContain(company.ownerEmail);
    expect(message.text).toContain("> Please\n> Subject: extra  line");
    expect(message.text).toContain(`${ORIGIN}/operator/requests/${id}`);
  });

  it("still records the request when no operator address is set", async () => {
    const company = await newCompany();
    operatorEmail = null;
    try {
      expect((await ask(company)).status).toBe(201);
    } finally {
      operatorEmail = OPERATOR_INBOX;
    }
    expect(
      await db.emailOutbox.count({ where: { companyId: company.id } }),
    ).toBe(0);
  });

  it("works while the company is read-only", async () => {
    const company = await newCompany({ lastDay: "2020-01-01" });
    expect((await ask(company)).status).toBe(201);
  });

  it("creates only one request under concurrency", async () => {
    const company = await newCompany();
    const responses = await Promise.all([ask(company), ask(company)]);
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(
      await db.trialExtensionRequest.count({
        where: { companyId: company.id },
      }),
    ).toBe(1);
  });

  it.each([
    ["an unrestricted company", { mode: "unrestricted" as const }],
    ["a demo company", { demo: true }],
  ])("refuses %s with 403", async (_name, options) => {
    const company = await newCompany(options);
    expect((await ask(company)).status).toBe(403);
    expect(
      await db.trialExtensionRequest.count({
        where: { companyId: company.id },
      }),
    ).toBe(0);
  });

  it("validates the body", async () => {
    const company = await newCompany();
    expect((await ask(company, { message: "x".repeat(1001) })).status).toBe(
      400,
    );
    expect((await ask(company, { companyId: randomUUID() })).status).toBe(400);
  });

  it("allows 3 requests in 7 days, then 429 with the wait", async () => {
    const company = await newCompany();
    for (let i = 0; i < 3; i += 1) {
      const id = await pendingFor(company);
      await db.trialExtensionRequest.update({
        where: { id },
        data: {
          status: "approved",
          decidedAt: new Date(),
          decidedBy: operatorId,
          extensionDays: 1,
          newLastDay: new Date("2099-01-02T00:00:00Z"),
        },
      });
    }
    const response = await ask(company);
    expect(response.status).toBe(429);
    const { retryAfterSeconds } = (await response.json()) as {
      retryAfterSeconds: number;
    };
    expect(retryAfterSeconds).toBeGreaterThan(6 * 86_400);
    expect(response.headers.get("retry-after")).toBe(String(retryAfterSeconds));
  });

  it("waits 24 hours after a decline", async () => {
    const company = await newCompany();
    const id = await pendingFor(company);
    expect((await decide(id, "decline", { reason: "Not now" })).status).toBe(
      200,
    );
    const response = await ask(company);
    expect(response.status).toBe(429);
    const { retryAfterSeconds } = (await response.json()) as {
      retryAfterSeconds: number;
    };
    expect(retryAfterSeconds).toBeGreaterThan(23 * 3600);
    expect(retryAfterSeconds).toBeLessThanOrEqual(24 * 3600);
  });

  it("shows owners the decline reason but not the approval note", async () => {
    const declined = await newCompany();
    const first = await pendingFor(declined);
    await decide(first, "decline", { reason: "Synthetic reason" });
    const approved = await newCompany();
    const second = await pendingFor(approved);
    await decide(second, "approve", { days: 5, note: "Internal note" });
    const declinedView = (await (await viewAs(declined)).json()) as {
      decisions: Record<string, unknown>[];
      pending: unknown;
    };
    expect(declinedView.pending).toBeNull();
    expect(declinedView.decisions[0]!.reason).toBe("Synthetic reason");
    const approvedView = await (await viewAs(approved)).text();
    expect(approvedView).not.toContain("Internal note");
    expect(approvedView).not.toContain(operatorId);
  });
});

describe("the operator decides", () => {
  it("lists pending requests oldest first, with only the agreed fields", async () => {
    const first = await newCompany();
    const firstId = await pendingFor(first);
    const second = await newCompany();
    const secondId = await pendingFor(second);
    const { requests } = (await (await list()).json()) as {
      requests: {
        id: string;
        company: Record<string, unknown>;
        owner: Record<string, unknown>;
      }[];
    };
    const ids = requests.map((r) => r.id);
    expect(ids.indexOf(firstId)).toBeLessThan(ids.indexOf(secondId));
    const row = requests.find((r) => r.id === firstId)!;
    expect(Object.keys(row).sort()).toEqual([
      "closedReason",
      "company",
      "createdAt",
      "decidedAt",
      "decisionNote",
      "extensionDays",
      "id",
      "lastDayAtRequest",
      "message",
      "newLastDay",
      "owner",
      "status",
    ]);
    expect(Object.keys(row.company).sort()).toEqual([
      "createdAt",
      "id",
      "lastDay",
      "mode",
      "name",
      "phase",
    ]);
    expect(Object.keys(row.owner).sort()).toEqual(["email", "name"]);
    await decide(firstId, "decline", { reason: "Synthetic" });
    await decide(secondId, "decline", { reason: "Synthetic" });
    const decided = (await (await list("?status=decided")).json()) as {
      requests: { id: string }[];
    };
    expect(decided.requests.map((r) => r.id)).toContain(firstId);
  });

  it("approves from the current last day when it's still ahead", async () => {
    const company = await newCompany({ lastDay: "2099-01-01" });
    const id = await pendingFor(company);
    const response = await decide(id, "approve", { days: 10 });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ lastDay: "2099-01-11" });
    expect(await lastDayOf(company.id)).toBe("2099-01-11");
    expect(
      await db.trialExtensionRequest.findUniqueOrThrow({ where: { id } }),
    ).toMatchObject({
      status: "approved",
      decidedBy: operatorId,
      extensionDays: 10,
    });
    const [event] = await db.auditEvent.findMany({
      where: { companyId: company.id, action: "trial_extension.approved" },
    });
    expect(event).toMatchObject({
      actorKind: "operator",
      operatorUserId: operatorId,
    });
  });

  it("approves an expired trial from yesterday, and makes it writable at once", async () => {
    const company = await newCompany({ lastDay: "2020-01-01" });
    const id = await pendingFor(company);
    const write = () =>
      withAudit(db, async (_tx, audit) => {
        await audit({
          companyId: company.id,
          actorUserId: company.ownerId,
          action: "company.profile_updated",
          target: { type: "company", id: company.id },
        });
      });
    await expect(write()).rejects.toThrow(/read_only/);
    expect((await decide(id, "approve", { days: 30 })).status).toBe(200);
    const lastDay = await lastDayOf(company.id);
    expect(lastDay! > new Date().toISOString().slice(0, 10)).toBe(true);
    await expect(write()).resolves.toBeUndefined();
  });

  it("declines with a reason and leaves the trial alone", async () => {
    const company = await newCompany();
    const id = await pendingFor(company);
    expect((await decide(id, "decline", {})).status).toBe(400);
    expect((await decide(id, "decline", { reason: "  " })).status).toBe(400);
    expect((await decide(id, "decline", { reason: "No" })).status).toBe(200);
    expect(await lastDayOf(company.id)).toBe("2099-01-01");
    expect(
      await db.auditEvent.count({
        where: { companyId: company.id, action: "trial_extension.declined" },
      }),
    ).toBe(1);
  });

  it("validates days", async () => {
    const company = await newCompany();
    const id = await pendingFor(company);
    for (const days of [0, 366, 1.5, "5"]) {
      expect((await decide(id, "approve", { days })).status).toBe(400);
    }
  });

  it("decides once: a second decision gets 409 and changes nothing", async () => {
    const company = await newCompany();
    const id = await pendingFor(company);
    await decide(id, "approve", { days: 1 });
    const lastDay = await lastDayOf(company.id);
    const again = await decide(id, "decline", { reason: "Too late" });
    expect(again.status).toBe(409);
    expect((await again.json()).code).toBe("already_decided");
    expect(await lastDayOf(company.id)).toBe(lastDay);
  });

  it("lets only one of two concurrent decisions through", async () => {
    const company = await newCompany();
    const id = await pendingFor(company);
    const responses = await Promise.all([
      decide(id, "approve", { days: 3 }),
      decide(id, "decline", { reason: "Synthetic" }),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(
      await db.auditEvent.count({
        where: {
          companyId: company.id,
          action: {
            in: ["trial_extension.approved", "trial_extension.declined"],
          },
        },
      }),
    ).toBe(1);
  });

  it("answers 400 for an unknown request and a malformed ID", async () => {
    expect(
      (await decide(randomUUID(), "decline", { reason: "x" })).status,
    ).toBe(400);
    expect(
      (await decide("not-a-uuid", "decline", { reason: "x" })).status,
    ).toBe(400);
  });

  it("tells every active, verified owner, by email and notice", async () => {
    const company = await newCompany();
    const second = await newUser();
    const unverified = await newUser(false);
    const inactive = await newUser();
    for (const [user, isActive] of [
      [second, true],
      [unverified, true],
      [inactive, false],
    ] as const) {
      await db.membership.create({
        data: {
          ...factory.membership(company.id, user.id),
          createdBy: company.ownerId,
          isActive,
        },
      });
    }
    const id = await pendingFor(company);
    await decide(id, "decline", { reason: "Synthetic reason" });
    const emails = await db.emailOutbox.findMany({
      where: { companyId: company.id, kind: "trial_extension_declined" },
    });
    expect(emails.map((e) => e.userId).sort()).toEqual(
      [company.ownerId, second.id].sort(),
    );
    expect(
      decryptPayload(SECRET, emails[0]!.payloadCiphertext!).text,
    ).toContain("Reason: Synthetic reason");
    const notices = await db.userNotice.findMany({
      where: { companyId: company.id, noticeKey: `trial.declined:${id}` },
    });
    expect(notices.map((n) => n.userId).sort()).toEqual(
      [company.ownerId, second.id].sort(),
    );
    expect(notices.every((n) => n.dismissedAt === null)).toBe(true);
  });

  it("extends and switches mode through the API, with clear refusals", async () => {
    const company = await newCompany();
    const call = (
      action: "extend" | "access",
      companyId: string,
      body: unknown,
    ) =>
      operator()[action]({
        operatorUserId: operatorId,
        request: jsonRequest(
          `/api/operator/companies/${companyId}/${action}`,
          body,
        ),
        context: { params: Promise.resolve({ id: companyId }) },
      });
    const shorter = await call("extend", company.id, {
      lastDay: "2098-01-01",
      reason: "Synthetic",
    });
    expect(shorter.status).toBe(400);
    expect((await shorter.json()).code).toBe("invalid_date");
    expect(
      (await call("access", company.id, { mode: "trial", reason: "x" })).status,
    ).toBe(400);
    expect(
      (
        await call("access", "not-a-uuid", {
          mode: "unrestricted",
          reason: "x",
        })
      ).status,
    ).toBe(400);
    const demo = await newCompany({ demo: true });
    const refused = await call("access", demo.id, {
      mode: "trial",
      lastDay: "2099-01-01",
      reason: "x",
    });
    expect(refused.status).toBe(400);
    expect((await refused.json()).code).toBe("demo_company");
    expect(
      (
        await call("access", company.id, {
          mode: "unrestricted",
          reason: "Synthetic",
        })
      ).status,
    ).toBe(200);
  });

  it("searches non-demo companies with the same projection", async () => {
    const company = await newCompany();
    await db.company.update({
      where: { id: company.id },
      data: { name: "Findable Synthetic Trades" },
    });
    const demo = await newCompany({ demo: true });
    await db.company.update({
      where: { id: demo.id },
      data: { name: "Findable Synthetic Demo" },
    });
    const response = await operator().listCompanies({
      operatorUserId: operatorId,
      request: jsonRequest("/api/operator/companies?q=findable"),
      context: undefined,
    });
    const { companies } = (await response.json()) as {
      companies: Record<string, unknown>[];
    };
    expect(companies.map((c) => c.id)).toEqual([company.id]);
    expect(Object.keys(companies[0]!).sort()).toEqual([
      "createdAt",
      "id",
      "lastDay",
      "mode",
      "name",
      "phase",
    ]);
  });

  it("includes requests and decisions in the company export", async () => {
    const company = await newCompany();
    const id = await pendingFor(company);
    await decide(id, "decline", { reason: "Synthetic" });
    const data = await exportCompany(db, company.id);
    expect(
      data.tables.trial_extension_requests!.rows.map((row) => row.id),
    ).toEqual([id]);
    expect(
      data.tables.audit_events!.rows.some(
        (row) => row.action === "trial_extension.declined",
      ),
    ).toBe(true);
  });
});
