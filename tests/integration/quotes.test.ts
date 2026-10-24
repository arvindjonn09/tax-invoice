import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../packages/database/src/generated/prisma/client";
import { createAuth } from "../../apps/web/src/server/auth/config";
import { createCredentialUser } from "../../apps/web/src/server/auth/credentials";
import { createWithPolicy } from "../../apps/web/src/server/authz/policy";
import { sydneyToday } from "../../apps/web/src/server/company/gst";
import { quoteHandlers } from "../../apps/web/src/server/quotes/handlers";
import {
  type CommittedDatabase,
  withCommittedDatabase,
} from "../helpers/committed-database";
import { syntheticFactory } from "../helpers/factories";

// #44: quotes and variations — frozen when sent, accepted once, converted to
// a job with estimated revenue ex GST; estimated profit never includes GST.
const ORIGIN = "http://127.0.0.1:3000";
const PASSWORD = "correct horse battery staple";
const WHO = ["owner", "manager", "accountant", "employee", "outsider"] as const;
type Who = (typeof WHO)[number];

let database: CommittedDatabase;
let db: PrismaClient;
let withPolicy: ReturnType<typeof createWithPolicy>;
let quotes: ReturnType<typeof quoteHandlers>;
let companyId = "";
let customerId = "";
let otherCustomerId = "";
let outsiderQuoteId = "";
const userIds = {} as Record<Who, string>;
const cookies = {} as Record<Who, Headers>;
const factory = syntheticFactory(0x4444);
const TODAY = sydneyToday();
const shift = (days: number) =>
  new Date(Date.parse(`${TODAY}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);

beforeAll(async () => {
  database = await withCommittedDatabase();
  db = database.client;
  const auth = createAuth({
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
  quotes = quoteHandlers(() => db);
  for (const key of WHO) {
    userIds[key] = (
      await createCredentialUser(db, {
        email: `${key}@jobflow.invalid`,
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
  // Registered from 1 July 2025; quotes sent before that can't charge GST.
  await db.companyGstRegistration.create({
    data: {
      companyId,
      createdBy: userIds.owner,
      startsOn: new Date("2025-07-01T00:00:00Z"),
      basis: "cash",
    },
  });
  for (const role of ["manager", "accountant", "employee"] as const)
    await db.membership.create({
      data: {
        companyId,
        userId: userIds[role],
        createdBy: userIds.owner,
        role,
      },
    });
  customerId = (
    await db.customer.create({
      data: { companyId, createdBy: userIds.owner, name: "Acme Sample" },
    })
  ).id;
  const theirs = await db.customer.create({
    data: { companyId: other.id, createdBy: userIds.outsider, name: "Theirs" },
  });
  otherCustomerId = theirs.id;
  outsiderQuoteId = (
    await db.quote.create({
      data: {
        companyId: other.id,
        number: 1,
        customerId: theirs.id,
        title: "Their quote",
        createdBy: userIds.outsider,
      },
    })
  ).id;
  let ip = 0;
  for (const key of WHO) {
    const response = await auth.handler(
      new Request(`${ORIGIN}/api/auth/sign-in/email`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: ORIGIN,
          "x-forwarded-for": `203.0.113.${(ip += 1)}`,
        },
        body: JSON.stringify({
          email: `${key}@jobflow.invalid`,
          password: PASSWORD,
        }),
      }),
    );
    expect(response.status).toBe(200);
    cookies[key] = new Headers({
      cookie: response.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; "),
    });
  }
}, 120_000);
afterAll(() => database?.release());

function call(who: Who, method: string, body?: unknown) {
  const h = new Headers(cookies[who]);
  h.set("origin", ORIGIN);
  const init: RequestInit = { method, headers: h };
  if (body !== undefined) {
    h.set("content-type", "application/json");
    init.body = JSON.stringify(body);
  }
  return new Request(`${ORIGIN}/api/x`, init);
}
type One = { params: Promise<{ id: string }> };
const one = (id: string): One => ({ params: Promise.resolve({ id }) });
const r = () => ({
  create: withPolicy("quote.write", quotes.create),
  read: withPolicy<One>("quote.read", quotes.read),
  update: withPolicy<One>("quote.write", quotes.update),
  discard: withPolicy<One>("quote.write", quotes.discard),
  send: withPolicy<One>("quote.write", quotes.send),
  revise: withPolicy<One>("quote.write", quotes.revise),
  accept: withPolicy<One>("quote.write", quotes.accept),
  decline: withPolicy<One>("quote.write", quotes.decline),
});

type QuoteView = {
  id: string;
  kind: string;
  status: string;
  state: string;
  number: number;
  revision: number;
  reference: string;
  revisesId: string | null;
  jobId: string | null;
  validUntil: string | null;
  gstRegistered: boolean | null;
  exclusiveCents: string;
  gstCents: string;
  inclusiveCents: string;
  estimate: {
    revenueExclusiveCents: string;
    costCents: string;
    profitCents: string;
    marginBasisPoints: string | null;
  };
  error?: string;
  fields?: Record<string, string>;
};

const FIT_OUT = {
  description: "Synthetic fit-out",
  quantity: "1",
  unitPriceCents: "250000",
  taxCode: "TAXABLE_10",
  estimatedCostCents: "145000",
};

async function json(response: Response) {
  return {
    status: response.status,
    body: (await response.json()) as QuoteView,
  };
}
async function draft(body: Record<string, unknown> = {}, who: Who = "manager") {
  return json(
    await r().create(
      call(who, "POST", {
        customerId,
        title: "Synthetic office fit-out",
        validUntil: shift(30),
        lines: [FIT_OUT],
        ...body,
      }),
      undefined,
    ),
  );
}
const act = async (
  action: "send" | "revise" | "accept" | "decline",
  id: string,
  body: unknown = {},
  who: Who = "manager",
) => json(await r()[action](call(who, "POST", body), one(id)));

describe("quotes (#44)", () => {
  it("draft → send → accept converts to an approved job with revenue ex GST", async () => {
    const created = await draft();
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      status: "draft",
      revision: 1,
      exclusiveCents: "250000",
      gstCents: "25000",
      // Estimated revenue and profit are GST-exclusive (docs/GST.md fixture).
      estimate: {
        revenueExclusiveCents: "250000",
        costCents: "145000",
        profitCents: "105000",
        marginBasisPoints: "4200",
      },
    });
    expect(created.body.reference).toMatch(/^Q-\d{4}$/);
    const sent = await act("send", created.body.id);
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({
      status: "sent",
      state: "sent",
      gstRegistered: true,
      inclusiveCents: "275000",
    });
    const accepted = await act("accept", created.body.id, {
      note: "Signed by the customer",
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body.status).toBe("accepted");
    const job = await db.job.findUniqueOrThrow({
      where: { id: accepted.body.jobId! },
      include: { statusEvents: { orderBy: { createdAt: "asc" } } },
    });
    expect(job).toMatchObject({
      status: "approved",
      customerId,
      title: "Synthetic office fit-out",
      agreedPriceExclusiveCents: 250_000n,
    });
    expect(job.statusEvents.map((e) => [e.fromStatus, e.toStatus])).toEqual([
      [null, "draft"],
      ["draft", "approved"],
    ]);
    expect(
      await db.auditEvent.count({
        where: {
          companyId,
          targetId: { in: [created.body.id, job.id] },
          action: {
            in: [
              "quote.drafted",
              "quote.sent",
              "quote.accepted",
              "job.created",
            ],
          },
        },
      }),
    ).toBe(4);
  });

  it("keeps an accepted quote immutable", async () => {
    const created = await draft();
    await act("send", created.body.id);
    await act("accept", created.body.id);
    expect(
      (
        await r().update(
          call("manager", "PATCH", { title: "Changed" }),
          one(created.body.id),
        )
      ).status,
    ).toBe(409);
    for (const action of ["accept", "decline", "revise", "send"] as const)
      expect((await act(action, created.body.id)).status, action).toBe(409);
    expect(
      (await r().discard(call("manager", "DELETE"), one(created.body.id)))
        .status,
    ).toBe(409);
    // The database refuses edits, line changes, re-linking and deletes too.
    await expect(
      db.quote.update({
        where: { id: created.body.id },
        data: { exclusiveCents: 1n },
      }),
    ).rejects.toThrow();
    await expect(
      db.quote.update({
        where: { id: created.body.id },
        data: {
          jobId: (await db.job.findFirstOrThrow({ where: { companyId } })).id,
        },
      }),
    ).rejects.toThrow();
    await expect(
      db.quote.update({
        where: { id: created.body.id },
        data: { status: "declined" },
      }),
    ).rejects.toThrow();
    await expect(
      db.quoteItem.updateMany({
        where: { quoteId: created.body.id },
        data: { unitPriceCents: 1n },
      }),
    ).rejects.toThrow();
    await expect(
      db.quote.delete({ where: { id: created.body.id } }),
    ).rejects.toThrow();
    const after = await json(
      await r().read(call("accountant", "GET"), one(created.body.id)),
    );
    expect(after.body).toMatchObject({
      status: "accepted",
      exclusiveCents: "250000",
    });
  });

  it("freezes a sent quote; drafts stay editable and can be discarded", async () => {
    const created = await draft();
    const edited = await json(
      await r().update(
        call("manager", "PATCH", {
          lines: [{ ...FIT_OUT, quantity: "2" }],
        }),
        one(created.body.id),
      ),
    );
    expect(edited.body.exclusiveCents).toBe("500000");
    await act("send", created.body.id);
    expect(
      (
        await r().update(
          call("manager", "PATCH", { title: "Changed" }),
          one(created.body.id),
        )
      ).status,
    ).toBe(409);
    await expect(
      db.quoteItem.create({
        data: {
          companyId,
          quoteId: created.body.id,
          position: 9,
          description: "Sneaky",
          quantity: "1",
          unitPriceCents: 1n,
          taxCode: "GST_FREE",
          gstRateBasisPoints: 0,
          exclusiveCents: 1n,
          gstCents: 0n,
          inclusiveCents: 1n,
        },
      }),
    ).rejects.toThrow();
    const scrap = await draft();
    expect(
      (await r().discard(call("manager", "DELETE"), one(scrap.body.id))).status,
    ).toBe(200);
    expect(await db.quote.count({ where: { id: scrap.body.id } })).toBe(0);
  });

  it("charges no GST when not registered on the send date", async () => {
    const taxable = await draft({ validUntil: null });
    const refused = await act("send", taxable.body.id, {
      sentOn: "2025-06-30",
    });
    expect(refused.status).toBe(400);
    expect(refused.body.fields).toHaveProperty("lines.0.taxCode");
    const plain = await draft({
      validUntil: null,
      lines: [{ ...FIT_OUT, taxCode: "OUT_OF_SCOPE" }],
    });
    const sent = await act("send", plain.body.id, { sentOn: "2025-06-30" });
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({
      gstRegistered: false,
      gstCents: "0",
      exclusiveCents: "250000",
      estimate: { profitCents: "105000" },
    });
  });

  it("revises: same number, next revision, supersedes the sent one", async () => {
    const first = await draft();
    await act("send", first.body.id);
    const revised = await act("revise", first.body.id);
    expect(revised.status).toBe(201);
    expect(revised.body).toMatchObject({
      status: "draft",
      number: first.body.number,
      revision: 2,
      revisesId: first.body.id,
      validUntil: null,
    });
    expect(revised.body.reference).toBe(`${first.body.reference} rev 2`);
    expect((await act("revise", first.body.id)).status).toBe(409);
    await r().update(
      call("manager", "PATCH", { validUntil: shift(14) }),
      one(revised.body.id),
    );
    await act("send", revised.body.id);
    const old = await json(
      await r().read(call("manager", "GET"), one(first.body.id)),
    );
    expect(old.body.status).toBe("superseded");
    expect((await act("accept", first.body.id)).status).toBe(409);
    expect((await act("accept", revised.body.id)).status).toBe(200);
  });

  it("expires after its validity date: accept refused, decline allowed", async () => {
    const created = await draft({ validUntil: shift(-10) });
    const early = await act("send", created.body.id, { sentOn: shift(-20) });
    expect(early.body.state).toBe("expired");
    const refused = await act("accept", created.body.id);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/expired/);
    const declined = await act("decline", created.body.id, {
      note: "Went elsewhere",
    });
    expect(declined.body.status).toBe("declined");
    const badDates = await draft({ validUntil: shift(-30) });
    expect(
      (await act("send", badDates.body.id, { sentOn: shift(-20) })).status,
    ).toBe(400);
    const notSent = await draft();
    expect((await act("accept", notSent.body.id)).status).toBe(409);
  });

  it("variations add to the job's estimated revenue; quotes for a draft job approve it", async () => {
    const base = await draft();
    await act("send", base.body.id);
    const jobId = (await act("accept", base.body.id)).body.jobId!;
    const variation = await draft({
      kind: "variation",
      jobId,
      title: "Extra power points",
      lines: [
        {
          description: "Four double power points",
          quantity: "4",
          unitPriceCents: "7500",
          taxCode: "TAXABLE_10",
          estimatedCostCents: "12000",
        },
      ],
    });
    expect(variation.status).toBe(201);
    await act("send", variation.body.id);
    expect((await act("accept", variation.body.id)).status).toBe(200);
    expect(
      (await db.job.findUniqueOrThrow({ where: { id: jobId } }))
        .agreedPriceExclusiveCents,
    ).toBe(280_000n);
    // A plain quote for an approved job is refused: quote a variation.
    expect((await draft({ jobId })).status).toBe(400);
    expect((await draft({ kind: "variation" })).status).toBe(400);
    // A quote made for an existing draft job approves it on acceptance.
    const draftJob = await db.job.create({
      data: {
        companyId,
        createdBy: userIds.owner,
        customerId,
        number: 9000 + Math.floor(Math.random() * 999),
        reference: `JOB-Q-${randomUUID().slice(0, 6)}`,
        title: "Pending work",
      },
    });
    const forJob = await draft({ jobId: draftJob.id });
    await act("send", forJob.body.id);
    expect((await act("accept", forJob.body.id)).body.jobId).toBe(draftJob.id);
    expect(
      await db.job.findUniqueOrThrow({ where: { id: draftJob.id } }),
    ).toMatchObject({
      status: "approved",
      agreedPriceExclusiveCents: 250_000n,
    });
    // A variation can't apply to a draft job.
    const another = await db.job.create({
      data: {
        companyId,
        createdBy: userIds.owner,
        customerId,
        number: 8000 + Math.floor(Math.random() * 999),
        reference: `JOB-Q-${randomUUID().slice(0, 6)}`,
        title: "Still a draft",
      },
    });
    expect((await draft({ kind: "variation", jobId: another.id })).status).toBe(
      400,
    );
  });

  it("accepts once under concurrency: one job", async () => {
    const created = await draft();
    await act("send", created.body.id);
    const results = await Promise.all([
      act("accept", created.body.id),
      act("accept", created.body.id),
      act("accept", created.body.id),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect(
      await db.job.count({
        where: {
          companyId,
          title: "Synthetic office fit-out",
          quotes: { some: { id: created.body.id } },
        },
      }),
    ).toBe(1);
  });

  it("is office-only to read and owner/manager to write, per company", async () => {
    const created = await draft({}, "owner");
    expect(created.status).toBe(201);
    for (const who of ["accountant", "employee"] as const)
      expect((await draft({}, who)).status, who).toBe(403);
    expect(
      (await r().read(call("accountant", "GET"), one(created.body.id))).status,
    ).toBe(200);
    expect(
      (await r().read(call("employee", "GET"), one(created.body.id))).status,
    ).toBe(403);
    expect(
      (await r().read(call("manager", "GET"), one(outsiderQuoteId))).status,
    ).toBe(404);
    expect((await act("send", outsiderQuoteId)).status).toBe(404);
    expect((await draft({ customerId: otherCustomerId })).status).toBe(400);
  });
});
