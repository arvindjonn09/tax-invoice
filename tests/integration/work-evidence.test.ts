import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../packages/database/src/generated/prisma/client";
import { createAuth } from "../../apps/web/src/server/auth/config";
import { createCredentialUser } from "../../apps/web/src/server/auth/credentials";
import { createWithPolicy } from "../../apps/web/src/server/authz/policy";
import { evidenceHandlers } from "../../apps/web/src/server/jobs/evidence";
import { jobHandlers } from "../../apps/web/src/server/jobs/handlers";
import {
  type CommittedDatabase,
  withCommittedDatabase,
} from "../helpers/committed-database";
import { syntheticFactory } from "../helpers/factories";

// #42: proof of work from the workers on a job, and completion review.
const ORIGIN = "http://127.0.0.1:3000";
const PASSWORD = "correct horse battery staple";
const WHO = [
  "owner",
  "manager",
  "accountant",
  "worker",
  "bystander",
  "sub",
  "othersub",
  "outsider",
  "visitonly",
  "leaver",
  "exsub",
] as const;
type Who = (typeof WHO)[number];
const ROLE: Record<Who, string> = {
  owner: "owner",
  manager: "manager",
  accountant: "accountant",
  worker: "employee",
  bystander: "employee",
  sub: "subcontractor",
  othersub: "subcontractor",
  outsider: "owner",
  visitonly: "employee",
  leaver: "employee",
  exsub: "subcontractor",
};

let database: CommittedDatabase;
let db: PrismaClient;
let withPolicy: ReturnType<typeof createWithPolicy>;
let handlers: ReturnType<typeof evidenceHandlers>;
let companyId = "";
let jobId = "";
let draftJobId = "";
let visitId = "";
let otherVisitId = "";
let otherJobVisitId = "";
let outsiderJobId = "";
const userIds = {} as Record<Who, string>;
const cookies = {} as Record<Who, Headers>;
const factory = syntheticFactory(0x4242);

async function documentFor(
  who: Who,
  { kind = "photo", contentType = "image/png" } = {},
) {
  return db.document.create({
    data: {
      companyId: who === "outsider" ? outsiderCompanyId : companyId,
      kind: kind as "photo",
      objectKey: `documents/${who === "outsider" ? outsiderCompanyId : companyId}/${randomBytes(32).toString("hex")}`,
      fileName: "site.png",
      contentType,
      sizeBytes: 10,
      sha256: randomBytes(32).toString("hex"),
      createdBy: userIds[who],
    },
  });
}
let outsiderCompanyId = "";

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
  handlers = evidenceHandlers(() => db);
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
  outsiderCompanyId = other.id;
  for (const key of WHO.filter((k) => k !== "owner" && k !== "outsider")) {
    await db.membership.create({
      data: {
        companyId,
        userId: userIds[key],
        createdBy: userIds.owner,
        role: ROLE[key] as "employee",
      },
    });
  }
  const customer = await db.customer.create({
    data: { companyId, createdBy: userIds.owner, name: "Acme Sample" },
  });
  const job = (number: number, status: "in_progress" | "draft") =>
    db.job.create({
      data: {
        companyId,
        createdBy: userIds.owner,
        customerId: customer.id,
        number,
        reference: `JOB-${number}`,
        title: `Job ${number}`,
        status,
      },
    });
  jobId = (await job(1, "in_progress")).id;
  draftJobId = (await job(2, "draft")).id;
  visitId = (
    await db.jobVisit.create({
      data: {
        companyId,
        jobId,
        createdBy: userIds.owner,
        startsAt: new Date("2026-11-02T22:00:00Z"),
      },
    })
  ).id;
  otherVisitId = (
    await db.jobVisit.create({
      data: {
        companyId,
        jobId,
        createdBy: userIds.owner,
        startsAt: new Date("2026-11-04T22:00:00Z"),
      },
    })
  ).id;
  otherJobVisitId = (
    await db.jobVisit.create({
      data: {
        companyId,
        jobId: draftJobId,
        createdBy: userIds.owner,
        startsAt: new Date("2026-11-03T22:00:00Z"),
      },
    })
  ).id;
  for (const [key, assign] of [
    ["worker", "job"],
    ["bystander", null],
    ["visitonly", "visit"],
    ["leaver", "job"],
  ] as const) {
    const employee = await db.employee.create({
      data: {
        companyId,
        createdBy: userIds.owner,
        name: `Employee ${key}`,
        userId: userIds[key],
      },
    });
    if (assign)
      await db.assignment.create({
        data: {
          companyId,
          jobId,
          employeeId: employee.id,
          visitId: assign === "visit" ? visitId : null,
          createdBy: userIds.owner,
        },
      });
  }
  for (const [key, accepted] of [
    ["sub", true],
    ["othersub", false],
    ["exsub", true],
  ] as const) {
    const contractor = await db.contractor.create({
      data: {
        companyId,
        createdBy: userIds.owner,
        name: `Contractor ${key}`,
        userId: userIds[key],
      },
    });
    await db.contractorOffer.create({
      data: {
        companyId,
        jobId,
        contractorId: contractor.id,
        createdBy: userIds.owner,
        scope: "Synthetic scope",
        rateType: "fixed",
        rateExclusiveCents: 50000n,
        taxCode: "TAXABLE_10",
        ...(accepted
          ? {
              status: "accepted",
              respondedAt: new Date(),
              respondedBy: userIds[key],
            }
          : {}),
      },
    });
  }
  const otherCustomer = await db.customer.create({
    data: {
      companyId: other.id,
      createdBy: userIds.outsider,
      name: "Theirs",
    },
  });
  outsiderJobId = (
    await db.job.create({
      data: {
        companyId: other.id,
        createdBy: userIds.outsider,
        customerId: otherCustomer.id,
        number: 1,
        reference: "JOB-1",
        title: "Their job",
        status: "in_progress",
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

function call(who: Who, method: string, body?: unknown): Request {
  const headers = new Headers(cookies[who]);
  headers.set("origin", ORIGIN);
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers.set("content-type", "application/json");
    init.body = JSON.stringify(body);
  }
  return new Request(`${ORIGIN}/api/x`, init);
}
type One = { params: Promise<{ id: string }> };
const one = (id: string): One => ({ params: Promise.resolve({ id }) });
const r = () => ({
  add: withPolicy("evidence.submit_assigned", handlers.add),
  mine: withPolicy("evidence.submit_assigned", handlers.mine),
  office: withPolicy("job.read_all", handlers.office),
  submit: withPolicy("evidence.submit_assigned", handlers.submit),
  review: withPolicy("job.write", handlers.review),
});
const add = (who: Who, body: unknown, id = jobId) =>
  r().add(call(who, "POST", body), one(id));

/** Resolves once another connection is waiting on a row lock (bounded). */
async function untilWaitingOnLock() {
  for (let i = 0; i < 100; i += 1) {
    const [row] = await db.$queryRaw<[{ waiting: bigint }]>`
      SELECT count(*) AS waiting FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if (row.waiting > 0n) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Run `revoke` in a transaction that holds `lock` (the row lock the real
 * revoking write takes) while `write` arrives and waits, then commit.
 */
async function revokeDuring(
  lock: (
    tx: Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0],
  ) => Promise<unknown>,
  write: () => Promise<Response>,
) {
  let pending: Promise<Response> | undefined;
  await db.$transaction(async (tx) => {
    await lock(tx);
    pending = write();
    await untilWaitingOnLock();
  });
  return pending!;
}

describe("adding evidence", () => {
  it("lets an assigned employee add a note and a photo of their own upload, audited", async () => {
    const note = await add("worker", {
      kind: "note",
      note: "Replaced the switchboard",
      visitId,
    });
    expect(note.status).toBe(201);
    const photo = await documentFor("worker");
    const added = await add("worker", {
      kind: "photo",
      documentId: photo.id,
      note: "After",
    });
    expect(added.status).toBe(201);
    expect(await added.json()).toMatchObject({
      kind: "photo",
      documentId: photo.id,
      note: "After",
    });
    expect(
      await db.auditEvent.count({
        where: { companyId, action: "job.evidence_added", targetId: jobId },
      }),
    ).toBe(2);
  });

  it("lets a subcontractor with an accepted offer add a customer signature", async () => {
    const signature = await documentFor("sub");
    expect(
      (await add("sub", { kind: "signature", documentId: signature.id }))
        .status,
    ).toBe(201);
  });

  it("refuses anyone not working on the job (404), whatever their role", async () => {
    for (const who of ["bystander", "othersub"] as const)
      expect(
        (await add(who, { kind: "note", note: "Not mine" })).status,
        who,
      ).toBe(404);
    // Office roles don't hold evidence.submit_assigned at all.
    for (const who of ["manager", "accountant", "owner"] as const)
      expect(
        (await add(who, { kind: "note", note: "Office" })).status,
        who,
      ).toBe(who === "owner" ? 404 : 403);
    // Another company's job, an unknown job, a bad id.
    for (const id of [
      outsiderJobId,
      "00000000-0000-4000-8000-000000000000",
      "x",
    ])
      expect(
        (await add("worker", { kind: "note", note: "Hijack" }, id)).status,
        id,
      ).toBe(404);
  });

  it("accepts only the worker's own image upload, once, and a visit of this job", async () => {
    const theirs = await documentFor("sub");
    const receipt = await documentFor("worker", {
      kind: "receipt",
      contentType: "image/png",
    });
    const pdf = await documentFor("worker", {
      kind: "other",
      contentType: "application/pdf",
    });
    for (const documentId of [theirs.id, receipt.id, pdf.id])
      expect(
        (await add("worker", { kind: "photo", documentId })).status,
        documentId,
      ).toBe(400);
    const photo = await documentFor("worker");
    expect(
      (await add("worker", { kind: "photo", documentId: photo.id })).status,
    ).toBe(201);
    expect(
      (await add("worker", { kind: "photo", documentId: photo.id })).status,
    ).toBe(400);
    expect(
      (
        await add("worker", {
          kind: "note",
          note: "Wrong visit",
          visitId: otherJobVisitId,
        })
      ).status,
    ).toBe(400);
    for (const body of [
      { kind: "note", note: "  " },
      { kind: "photo" },
      { kind: "video", documentId: photo.id },
    ])
      expect((await add("worker", body)).status, JSON.stringify(body)).toBe(
        400,
      );
  });

  it("is append-only, even for direct database writes", async () => {
    await expect(
      db.workEvidence.updateMany({
        where: { jobId },
        data: { note: "rewritten" },
      }),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.workEvidence.deleteMany({ where: { jobId } }),
    ).rejects.toThrow(/append-only/);
  });

  it("shows workers only their own evidence; the office sees all of it", async () => {
    const mine = await (
      await r().mine(call("worker", "GET"), one(jobId))
    ).json();
    expect(
      mine.evidence.every(
        (e: { submittedBy: string }) => e.submittedBy === userIds.worker,
      ),
    ).toBe(true);
    const all = await (
      await r().office(call("accountant", "GET"), one(jobId))
    ).json();
    expect(
      new Set(all.evidence.map((e: { submittedBy: string }) => e.submittedBy)),
    ).toEqual(new Set([userIds.worker, userIds.sub]));
    expect((await r().mine(call("bystander", "GET"), one(jobId))).status).toBe(
      404,
    );
    expect(
      (await r().office(call("owner", "GET"), one(outsiderJobId))).status,
    ).toBe(404);
  });
});

describe("visit-only assignments (Codex #125 review, P2)", () => {
  it("lets a visit-only employee attach evidence to their visit, not another", async () => {
    expect(
      (await add("visitonly", { kind: "note", note: "Visit A", visitId }))
        .status,
    ).toBe(201);
    const refused = await add("visitonly", {
      kind: "note",
      note: "Visit B",
      visitId: otherVisitId,
    });
    expect(refused.status).toBe(400);
    expect((await refused.json()).fields).toHaveProperty("visitId");
    expect(
      await db.workEvidence.count({ where: { visitId: otherVisitId } }),
    ).toBe(0);
    // A whole-job worker may use any visit of the job.
    expect(
      (
        await add("worker", {
          kind: "note",
          note: "Visit B",
          visitId: otherVisitId,
        })
      ).status,
    ).toBe(201);
  });
});

describe("revocation during a write (Codex #125 review, P1)", () => {
  const evidenceAudits = (who: Who) =>
    db.auditEvent.count({
      where: { action: "job.evidence_added", createdBy: userIds[who] },
    });

  it("adds nothing when the employee is deactivated while the write waits", async () => {
    const employee = await db.employee.findFirstOrThrow({
      where: { companyId, userId: userIds.leaver },
    });
    const response = await revokeDuring(
      async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM employees WHERE id = ${employee.id}::uuid FOR UPDATE`;
        await tx.employee.update({
          where: { id: employee.id },
          data: { isActive: false },
        });
      },
      () => add("leaver", { kind: "note", note: "Sneaking in" }),
    );
    expect(response.status).toBe(404);
    expect(
      await db.workEvidence.count({ where: { submittedBy: userIds.leaver } }),
    ).toBe(0);
    expect(await evidenceAudits("leaver")).toBe(0);
  });

  it("neither adds evidence nor submits when the contractor is archived meanwhile", async () => {
    const contractor = await db.contractor.findFirstOrThrow({
      where: { companyId, userId: userIds.exsub },
    });
    const archive = async (
      tx: Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0],
      data: { archivedAt: Date | null },
    ) => {
      await tx.$queryRaw`SELECT 1 FROM contractors WHERE id = ${contractor.id}::uuid FOR UPDATE`;
      await tx.contractor.update({ where: { id: contractor.id }, data });
    };
    const added = await revokeDuring(
      (tx) => archive(tx, { archivedAt: new Date() }),
      () => add("exsub", { kind: "note", note: "After archive" }),
    );
    expect(added.status).toBe(404);
    expect(
      await db.workEvidence.count({ where: { submittedBy: userIds.exsub } }),
    ).toBe(0);
    expect(await evidenceAudits("exsub")).toBe(0);

    // Restore, then archive again while a submit waits.
    await db.contractor.update({
      where: { id: contractor.id },
      data: { archivedAt: null },
    });
    const events = await db.jobStatusEvent.count({ where: { jobId } });
    const submitted = await revokeDuring(
      (tx) => archive(tx, { archivedAt: new Date() }),
      () => r().submit(call("exsub", "POST", {}), one(jobId)),
    );
    expect(submitted.status).toBe(404);
    expect(
      (await db.job.findUniqueOrThrow({ where: { id: jobId } })).status,
    ).toBe("in_progress");
    expect(await db.jobStatusEvent.count({ where: { jobId } })).toBe(events);
    expect(
      await db.auditEvent.count({
        where: {
          action: "job.submitted_for_review",
          createdBy: userIds.exsub,
        },
      }),
    ).toBe(0);
  });
});

describe("completion review", () => {
  it("needs evidence before submitting; a draft job can't take evidence", async () => {
    expect(
      (await add("worker", { kind: "note", note: "Early" }, draftJobId)).status,
    ).toBe(404); // not assigned to the draft job
    expect(
      (await r().submit(call("worker", "POST", {}), one(draftJobId))).status,
    ).toBe(404);
  });

  it("submit → rework → resubmit → approve, each recorded in the status history", async () => {
    const statusOf = async () =>
      (await db.job.findUniqueOrThrow({ where: { id: jobId } })).status;
    expect(
      (await r().submit(call("worker", "POST", {}), one(jobId))).status,
    ).toBe(200);
    expect(await statusOf()).toBe("awaiting_review");
    // The plain status route can't skip the review (Codex #125 review).
    const status = withPolicy("job.write", jobHandlers(() => db).changeStatus);
    for (const to of ["completed", "in_progress"])
      expect(
        (await status(call("manager", "POST", { to }), one(jobId))).status,
        to,
      ).toBe(409);
    expect(await statusOf()).toBe("awaiting_review");
    // A second submit while awaiting review is refused.
    expect((await r().submit(call("sub", "POST", {}), one(jobId))).status).toBe(
      409,
    );
    // Workers can't approve; rework needs a note.
    expect(
      (
        await r().review(
          call("worker", "POST", { decision: "approve" }),
          one(jobId),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await r().review(
          call("manager", "POST", { decision: "rework" }),
          one(jobId),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await r().review(
          call("manager", "POST", {
            decision: "rework",
            note: "Photo of the meter please",
          }),
          one(jobId),
        )
      ).status,
    ).toBe(200);
    expect(await statusOf()).toBe("in_progress");
    // Every worker on the job can read what to redo (Codex #125 review).
    for (const who of ["worker", "sub"] as const) {
      const view = await (await r().mine(call(who, "GET"), one(jobId))).json();
      expect(view.reworkRequests, who).toEqual([
        { note: "Photo of the meter please", requestedAt: expect.any(String) },
      ]);
    }
    const meter = await documentFor("worker");
    await add("worker", { kind: "photo", documentId: meter.id });
    await r().submit(call("worker", "POST", {}), one(jobId));
    const approved = await r().review(
      call("manager", "POST", { decision: "approve" }),
      one(jobId),
    );
    expect(await approved.json()).toEqual({ status: "completed" });
    expect(await statusOf()).toBe("completed");
    const history = await db.jobStatusEvent.findMany({
      where: { jobId },
      orderBy: { seq: "asc" },
    });
    expect(history.map((e) => `${e.fromStatus}→${e.toStatus}`)).toEqual([
      "in_progress→awaiting_review",
      "awaiting_review→in_progress",
      "in_progress→awaiting_review",
      "awaiting_review→completed",
    ]);
    // Completed: no more evidence, no second approval.
    expect((await add("worker", { kind: "note", note: "Late" })).status).toBe(
      409,
    );
    expect(
      (
        await r().review(
          call("manager", "POST", { decision: "approve" }),
          one(jobId),
        )
      ).status,
    ).toBe(409);
    for (const action of [
      "job.submitted_for_review",
      "job.rework_requested",
      "job.completion_approved",
    ])
      expect(
        await db.auditEvent.count({ where: { companyId, action } }),
        action,
      ).toBeGreaterThan(0);
  });
});
