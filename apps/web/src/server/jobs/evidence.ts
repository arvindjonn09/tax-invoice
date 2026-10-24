import { type Actor, notFound } from "@jobflow/authz";
import { type JobStatus, transitionProblem } from "@jobflow/domain";
import { z } from "zod";
import type {
  Prisma,
  PrismaClient,
  WorkEvidence,
} from "../../../../../packages/database/src/generated/prisma/client";
import {
  type AuditRecorder,
  withAudit,
} from "../../../../../packages/database/src/index";
import { type PolicyHandler, privateJson } from "../authz/policy";
import { invalid, jsonOrNull } from "../company/handlers";
import { lockRow } from "../db/locks";
import { optionalText, uuidOrNull } from "../http/fields";
import { Refusal, inTransaction, lockedJob } from "./handlers";

// #42. Workers on a job — employees with a live assignment, subcontractors
// with an accepted offer — add photos, notes and customer signatures, then
// submit the job for review. A manager approves completion or sends it back.
// Evidence is append-only; files are private documents the submitter
// uploaded (#34), reachable only through authorised signed links.

type JobContext = { params: Promise<{ id: string }> };

/** Statuses in which work (and so evidence) happens. */
const WORKING: readonly JobStatus[] = [
  "assigned",
  "in_progress",
  "awaiting_review",
];

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic"];

const AddEvidence = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("note"),
    note: z.string().trim().min(1, "Write the note").max(2000),
    visitId: z.uuid().nullable().optional(),
  }),
  z.object({
    kind: z.enum(["photo", "signature"]),
    documentId: z.uuid("Upload the image first"),
    note: optionalText(2000).optional(),
    visitId: z.uuid().nullable().optional(),
  }),
]);

const Review = z.object({
  decision: z.enum(["approve", "rework"]),
  note: optionalText(500).optional(),
});
const Submit = z.object({ note: optionalText(500).optional() });

const fail = (status: 400 | 409, error: string, field?: string) =>
  privateJson(
    { error, ...(field ? { fields: { [field]: error } } : {}) },
    {
      status,
    },
  );

/** Where on the job a worker may work: the whole job, or only some visits. */
type WorkerScope = { wholeJob: boolean; visitIds: readonly string[] };

/**
 * The actor's scope on this job right now, or null if they aren't one of
 * its workers. An employee assigned only to visits keeps to those visits
 * (#32); an accepted subcontractor offer covers the whole job (#35).
 */
export async function workerScope(
  db: Prisma.TransactionClient | PrismaClient,
  actor: Actor,
  jobId: string,
): Promise<WorkerScope | null> {
  if (actor.role === "employee") {
    const assignments = await db.assignment.findMany({
      where: {
        companyId: actor.companyId,
        jobId,
        endedAt: null,
        employee: { userId: actor.userId, isActive: true },
      },
      select: { visitId: true },
    });
    if (!assignments.length) return null;
    return {
      wholeJob: assignments.some((row) => row.visitId === null),
      visitIds: assignments.flatMap((row) => row.visitId ?? []),
    };
  }
  if (actor.role === "subcontractor") {
    const offer = await db.contractorOffer.findFirst({
      where: {
        companyId: actor.companyId,
        jobId,
        status: "accepted",
        contractor: { userId: actor.userId, archivedAt: null },
      },
      select: { id: true },
    });
    return offer ? { wholeJob: true, visitIds: [] } : null;
  }
  return null;
}

/**
 * Lock the job and the actor's worker record in the order the revoking
 * writes take them — subcontractors: contractor, then job (#35, unlink and
 * archive lock the contractor); employees: job, then employee (#32,
 * assignment endings lock the job, deactivation and unlinking the employee)
 * — then check the actor is still a worker on it. Nothing that revokes
 * their access can commit between this check and the caller's write.
 */
async function lockedWorkerJob(
  tx: Prisma.TransactionClient,
  actor: Actor,
  jobId: string,
) {
  const where = { companyId: actor.companyId, userId: actor.userId };
  if (actor.role === "subcontractor") {
    const contractor = await tx.contractor.findFirst({
      where,
      select: { id: true },
    });
    if (!contractor) throw notFound();
    await lockRow(tx, "contractors", contractor.id);
  }
  const job = await lockedJob(tx, jobId).catch(() => null);
  if (!job || job.companyId !== actor.companyId) throw notFound();
  if (actor.role === "employee") {
    const employee = await tx.employee.findFirst({
      where,
      select: { id: true },
    });
    if (!employee) throw notFound();
    await lockRow(tx, "employees", employee.id);
  }
  const scope = await workerScope(tx, actor, jobId);
  if (!scope) throw notFound();
  return { job, scope };
}

function evidenceView(row: WorkEvidence) {
  return {
    id: row.id,
    jobId: row.jobId,
    visitId: row.visitId,
    kind: row.kind,
    documentId: row.documentId,
    note: row.note,
    submittedBy: row.submittedBy,
    createdAt: row.createdAt,
  };
}

/**
 * Move a locked job one step along the status machine: compare-and-set,
 * immutable status event and audit, in the caller's transaction.
 */
async function moveJob(
  tx: Prisma.TransactionClient,
  audit: AuditRecorder,
  actor: Actor,
  job: { id: string; status: JobStatus },
  to: JobStatus,
  note: string | null,
  action: string,
) {
  const problem = transitionProblem(job.status, to, { byReview: true });
  if (problem)
    throw new Refusal(
      fail(409, `A ${job.status} job can't move to ${to}`, "status"),
    );
  await tx.job.update({ where: { id: job.id }, data: { status: to } });
  await tx.jobStatusEvent.create({
    data: {
      companyId: actor.companyId,
      jobId: job.id,
      fromStatus: job.status,
      toStatus: to,
      note,
      createdBy: actor.userId,
    },
  });
  await audit({
    companyId: actor.companyId,
    actorUserId: actor.userId,
    action,
    target: { type: "job", id: job.id },
    before: { status: job.status },
    after: { status: to },
  });
}

export function evidenceHandlers(db: () => PrismaClient) {
  /** A worker on the job adds a photo, note or signature (audited). */
  const add: PolicyHandler<JobContext> = async ({
    actor,
    request,
    context,
  }) => {
    const parsed = AddEvidence.safeParse(await jsonOrNull(request));
    if (!parsed.success) return invalid(parsed.error);
    const jobId = uuidOrNull((await context.params).id);
    if (!jobId) throw notFound();
    const data = parsed.data;
    try {
      return await inTransaction(async () => {
        const row = await withAudit(db(), async (tx, audit) => {
          const { job, scope } = await lockedWorkerJob(tx, actor, jobId);
          if (!WORKING.includes(job.status))
            throw new Refusal(
              fail(409, `Evidence can't be added to a ${job.status} job`),
            );
          if (data.visitId) {
            const visit = await tx.jobVisit.findFirst({
              where: { id: data.visitId, companyId: actor.companyId, jobId },
              select: { id: true },
            });
            if (
              !visit ||
              !(scope.wholeJob || scope.visitIds.includes(visit.id))
            )
              throw new Refusal(
                fail(400, "Choose one of your visits on this job", "visitId"),
              );
          }
          if (data.kind !== "note") {
            const document = await tx.document.findFirst({
              where: { id: data.documentId, companyId: actor.companyId },
              include: { workEvidence: { select: { id: true } } },
            });
            // Only the worker's own upload, an image, used once.
            if (
              !document ||
              document.createdBy !== actor.userId ||
              !["photo", "other"].includes(document.kind) ||
              !IMAGE_TYPES.includes(document.contentType)
            )
              throw new Refusal(
                fail(400, "Attach one of your uploaded images", "documentId"),
              );
            if (document.workEvidence)
              throw new Refusal(
                fail(400, "That image is already evidence", "documentId"),
              );
          }
          const created = await tx.workEvidence.create({
            data: {
              companyId: actor.companyId,
              jobId,
              visitId: data.visitId ?? null,
              kind: data.kind,
              documentId: data.kind === "note" ? null : data.documentId,
              note: data.note ?? null,
              submittedBy: actor.userId,
            },
          });
          await audit({
            companyId: actor.companyId,
            actorUserId: actor.userId,
            action: "job.evidence_added",
            target: { type: "job", id: jobId },
            after: {
              evidenceId: created.id,
              kind: created.kind,
              documentId: created.documentId,
            },
          });
          return created;
        });
        return privateJson(evidenceView(row), { status: 201 });
      });
    } catch (error) {
      if (
        /P2002|23505/.test(`${String(error)} ${JSON.stringify(error ?? null)}`)
      )
        return fail(400, "That image is already evidence", "documentId");
      throw error;
    }
  };

  /**
   * A worker's view: their own evidence on a job they're on, and what the
   * office asked to redo each time it sent the work back.
   */
  const mine: PolicyHandler<JobContext> = async ({ actor, context }) => {
    const jobId = uuidOrNull((await context.params).id);
    if (!jobId || !(await workerScope(db(), actor, jobId))) throw notFound();
    const [rows, reworks] = await Promise.all([
      db().workEvidence.findMany({
        where: { companyId: actor.companyId, jobId, submittedBy: actor.userId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }),
      db().jobStatusEvent.findMany({
        where: {
          companyId: actor.companyId,
          jobId,
          fromStatus: "awaiting_review",
          toStatus: "in_progress",
        },
        select: { note: true, createdAt: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }),
    ]);
    return privateJson({
      evidence: rows.map(evidenceView),
      reworkRequests: reworks.map((row) => ({
        note: row.note,
        requestedAt: row.createdAt,
      })),
    });
  };

  /** The office's view: all evidence on a job of this company. */
  const office: PolicyHandler<JobContext> = async ({ actor, context }) => {
    const jobId = uuidOrNull((await context.params).id);
    const job = jobId
      ? await db().job.findFirst({
          where: { id: jobId, companyId: actor.companyId },
          select: { id: true },
        })
      : null;
    if (!job) throw notFound();
    const rows = await db().workEvidence.findMany({
      where: { companyId: actor.companyId, jobId: job.id },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    return privateJson({ evidence: rows.map(evidenceView) });
  };

  /** A worker on the job submits it for review: in_progress → awaiting_review. */
  const submit: PolicyHandler<JobContext> = async ({
    actor,
    request,
    context,
  }) => {
    const parsed = Submit.safeParse((await jsonOrNull(request)) ?? {});
    if (!parsed.success) return invalid(parsed.error);
    const jobId = uuidOrNull((await context.params).id);
    if (!jobId) throw notFound();
    return inTransaction(async () => {
      await withAudit(db(), async (tx, audit) => {
        const { job } = await lockedWorkerJob(tx, actor, jobId);
        if (
          (await tx.workEvidence.count({
            where: { companyId: actor.companyId, jobId },
          })) === 0
        )
          throw new Refusal(
            fail(409, "Add at least one photo, note or signature first"),
          );
        await moveJob(
          tx,
          audit,
          actor,
          job,
          "awaiting_review",
          parsed.data.note ?? null,
          "job.submitted_for_review",
        );
      });
      return privateJson({ status: "awaiting_review" });
    });
  };

  /**
   * A manager reviews the submitted work: approve → completed (needs
   * evidence), rework → back to in_progress with a note.
   */
  const review: PolicyHandler<JobContext> = async ({
    actor,
    request,
    context,
  }) => {
    const parsed = Review.safeParse(await jsonOrNull(request));
    if (!parsed.success) return invalid(parsed.error);
    const { decision, note = null } = parsed.data;
    if (decision === "rework" && !note)
      return fail(400, "Say what needs redoing", "note");
    const jobId = uuidOrNull((await context.params).id);
    if (!jobId) throw notFound();
    return inTransaction(async () => {
      const to: JobStatus =
        decision === "approve" ? "completed" : "in_progress";
      await withAudit(db(), async (tx, audit) => {
        const job = await lockedJob(tx, jobId).catch(() => null);
        if (!job || job.companyId !== actor.companyId) throw notFound();
        if (job.status !== "awaiting_review")
          throw new Refusal(fail(409, "The job isn't awaiting review"));
        if (
          decision === "approve" &&
          (await tx.workEvidence.count({
            where: { companyId: actor.companyId, jobId },
          })) === 0
        )
          throw new Refusal(fail(409, "There's no evidence to approve"));
        await moveJob(
          tx,
          audit,
          actor,
          job,
          to,
          note,
          decision === "approve"
            ? "job.completion_approved"
            : "job.rework_requested",
        );
      });
      return privateJson({ status: to });
    });
  };

  return { add, mine, office, submit, review };
}
