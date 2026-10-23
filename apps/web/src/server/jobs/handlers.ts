import {
  type Actor,
  type FieldRules,
  companyScope,
  requireSameCompany,
  visibleFields,
} from "@jobflow/authz";
import {
  JOB_STATUSES,
  formatJobReference,
  isJobEditable,
  transitionProblem,
} from "@jobflow/domain";
import { z } from "zod";
import type {
  Job,
  JobStatusEvent,
  JobVisit,
  Prisma,
  PrismaClient,
} from "../../../../../packages/database/src/generated/prisma/client";
import { withAudit } from "../../../../../packages/database/src/index";
import { type PolicyHandler, privateJson } from "../authz/policy";
import { invalid, jsonOrNull } from "../company/handlers";
import { toDay } from "../company/gst";
import { lockRow } from "../db/locks";
import { assignmentView } from "./views";
import { jobSearch, jobOrder } from "./search";
import {
  defined,
  optionalText,
  requiredText,
  uuidOrNull,
} from "../http/fields";
import { parsePage } from "../http/guards";

// #31. Reads: job.read_all (office). Employee assigned-only reads use
// my-jobs (#32); the subcontractor portal is #37. Writes: job.write (owner,
// manager). The agreed price is only returned with job.price.read.

type JobView = Omit<Job, "agreedPriceExclusiveCents" | "dueOn"> & {
  agreedPriceExclusiveCents: string | null;
  dueOn: string | null;
};

const JOB_FIELDS: FieldRules<JobView> = {
  id: true,
  number: true,
  reference: true,
  customerId: true,
  locationId: true,
  title: true,
  description: true,
  status: true,
  agreedPriceExclusiveCents: "job.price.read",
  dueOn: true,
  createdAt: true,
  updatedAt: true,
};

/** Money leaves the API as integer-cent strings: exact, never floats. */
function view(job: Job): JobView {
  return {
    ...job,
    agreedPriceExclusiveCents:
      job.agreedPriceExclusiveCents === null
        ? null
        : job.agreedPriceExclusiveCents.toString(),
    dueOn: job.dueOn ? toDay(job.dueOn) : null,
  };
}

function eventView(
  event: JobStatusEvent & { creator: { user: { name: string | null } } },
) {
  return {
    id: event.id,
    fromStatus: event.fromStatus,
    toStatus: event.toStatus,
    note: event.note,
    createdAt: event.createdAt,
    createdBy: event.createdBy,
    actorName: event.creator.user.name ?? "Team member",
  };
}

function visitView(visit: JobVisit) {
  return {
    id: visit.id,
    startsAt: visit.startsAt,
    endsAt: visit.endsAt,
    status: visit.status,
    notes: visit.notes,
  };
}

/** GST-exclusive cents as a non-negative integer (number or digit string). */
const cents = z
  .union([z.string().regex(/^\d{1,13}$/, "Whole cents only"), z.number().int()])
  .transform((value, context) => {
    const amount = BigInt(value);
    if (amount < 0n || amount > 1_000_000_000_000n) {
      context.addIssue({ code: "custom", message: "Enter a price from $0" });
      return z.NEVER;
    }
    return amount;
  });

const jobFields = {
  title: requiredText(200, "Enter a job title"),
  description: optionalText(4000),
  locationId: z.uuid().nullable(),
  agreedPriceExclusiveCents: cents.nullable(),
  dueOn: z.iso.date("Use a date like 2026-07-01").nullable(),
};
const CreateJob = z
  .object({ customerId: z.uuid("Choose a customer"), ...jobFields })
  .partial()
  .required({ customerId: true, title: true });
const UpdateJob = z
  .object(jobFields)
  .partial()
  .refine((value) => Object.keys(value).length > 0, "Nothing to update");
const ChangeStatus = z.object({
  to: z.enum(JOB_STATUSES),
  note: optionalText(500).optional(),
});
const visitFields = {
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }).nullable(),
  status: z.enum(["scheduled", "completed", "cancelled"]),
  notes: optionalText(1000),
};
const CreateVisit = z
  .object(visitFields)
  .partial()
  .required({ startsAt: true });
const UpdateVisit = z
  .object(visitFields)
  .partial()
  .refine((value) => Object.keys(value).length > 0, "Nothing to update");

type JobContext = { params: Promise<{ id: string }> };
type VisitContext = { params: Promise<{ id: string; visitId: string }> };

const fail = (status: 400 | 409, error: string, field?: string) =>
  privateJson(
    { error, ...(field ? { fields: { [field]: error } } : {}) },
    {
      status,
    },
  );

const TRANSITION_MESSAGES = {
  "same-status": "The job already has that status",
  "not-allowed": "That status change isn't allowed from the current status",
  "system-only":
    "That change happens through invoicing: a job becomes invoiced when an invoice is issued, and an invoiced job is cancelled with its credit note",
} as const;

async function ownJob(db: PrismaClient, actor: Actor, id: string) {
  const safe = uuidOrNull(id);
  return requireSameCompany(
    actor,
    safe ? await db.job.findUnique({ where: { id: safe } }) : null,
  );
}

/**
 * The customer must be active in this company, and the site (if any) must be
 * an active location of that customer. Returns a field error or null.
 */
async function siteProblem(
  db: PrismaClient,
  companyId: string,
  customerId: string,
  locationId: string | null | undefined,
  { requireActiveCustomer }: { requireActiveCustomer: boolean },
): Promise<[string, string] | null> {
  const customer = await db.customer.findFirst({
    where: { id: customerId, companyId },
    select: { archivedAt: true },
  });
  if (!customer || (requireActiveCustomer && customer.archivedAt))
    return ["customerId", "Choose an active customer"];
  if (!locationId) return null;
  const location = await db.location.findFirst({
    where: { id: locationId, companyId, customerId, archivedAt: null },
    select: { id: true },
  });
  return location
    ? null
    : ["locationId", "Choose one of this customer's sites"];
}

/** Next per-company number, atomically (row lock until commit). */
async function nextNumber(
  tx: Prisma.TransactionClient,
  companyId: string,
  kind: "job",
): Promise<number> {
  const rows = await tx.$queryRaw<{ last_value: number }[]>`
    INSERT INTO number_sequences (company_id, kind, last_value)
    VALUES (${companyId}::uuid, ${kind}, 1)
    ON CONFLICT (company_id, kind)
    DO UPDATE SET last_value = number_sequences.last_value + 1
    RETURNING last_value`;
  const value = rows[0]?.last_value;
  if (!value) throw new Error("Numbering failed");
  return value;
}

function jobResponse(actor: Actor, job: Job): Response {
  return privateJson(visibleFields(actor, view(job), JOB_FIELDS));
}

export function jobHandlers(db: () => PrismaClient) {
  const list: PolicyHandler<unknown> = async ({ actor, request }) => {
    const params = new URL(request.url).searchParams;
    const { page, take, skip } = parsePage(params);
    const customerId = uuidOrNull(params.get("customerId") ?? "");
    const filter: Prisma.JobWhereInput = {
      ...jobSearch(params),
      ...(customerId ? { customerId } : {}),
    };
    const where: Prisma.JobWhereInput = companyScope(actor, filter);
    const [rows, total] = await Promise.all([
      db().job.findMany({
        where,
        orderBy: jobOrder(params),
        take,
        skip,
      }),
      db().job.count({ where }),
    ]);
    return privateJson({
      page,
      pageSize: take,
      total,
      jobs: rows.map((row) => visibleFields(actor, view(row), JOB_FIELDS)),
    });
  };

  /** A job with its visits and full status timeline (oldest first). */
  const read: PolicyHandler<JobContext> = async ({ actor, context }) => {
    const job = await ownJob(db(), actor, (await context.params).id);
    const [events, visits, assignments] = await Promise.all([
      db().jobStatusEvent.findMany({
        where: { companyId: actor.companyId, jobId: job.id },
        // Insertion order (monotonic sequence), not same-millisecond timestamps.
        orderBy: [{ seq: "asc" }],
        include: { creator: { select: { user: { select: { name: true } } } } },
      }),
      db().jobVisit.findMany({
        where: { companyId: actor.companyId, jobId: job.id },
        orderBy: [{ startsAt: "asc" }],
      }),
      db().assignment.findMany({
        where: { companyId: actor.companyId, jobId: job.id },
        include: { employee: { select: { name: true, isActive: true } } },
        orderBy: [{ assignedAt: "asc" }],
      }),
    ]);
    return privateJson({
      ...visibleFields(actor, view(job), JOB_FIELDS),
      statusHistory: events.map(eventView),
      visits: visits.map(visitView),
      assignments: assignments.map(assignmentView),
    });
  };

  const create: PolicyHandler<unknown> = async ({ actor, request }) => {
    const parsed = CreateJob.safeParse(await jsonOrNull(request));
    if (!parsed.success) return invalid(parsed.error);
    const { dueOn, ...data } = defined(parsed.data);
    const problem = await siteProblem(
      db(),
      actor.companyId,
      data.customerId,
      data.locationId,
      { requireActiveCustomer: true },
    );
    if (problem) return fail(400, problem[1], problem[0]);
    const job = await withAudit(db(), async (tx, audit) => {
      const number = await nextNumber(tx, actor.companyId, "job");
      const { jobPrefix } = await tx.company.findUniqueOrThrow({
        where: { id: actor.companyId },
        select: { jobPrefix: true },
      });
      const created = await tx.job.create({
        data: {
          ...data,
          ...(dueOn !== undefined
            ? { dueOn: dueOn ? new Date(`${dueOn}T00:00:00Z`) : null }
            : {}),
          companyId: actor.companyId,
          createdBy: actor.userId,
          number,
          reference: formatJobReference(jobPrefix, number),
          status: "draft",
        },
      });
      await tx.jobStatusEvent.create({
        data: {
          companyId: actor.companyId,
          jobId: created.id,
          fromStatus: null,
          toStatus: "draft",
          createdBy: actor.userId,
        },
      });
      await audit({
        companyId: actor.companyId,
        actorUserId: actor.userId,
        action: "job.created",
        target: { type: "job", id: created.id },
        after: {
          reference: created.reference,
          customerId: created.customerId,
          title: created.title,
          agreedPriceExclusiveCents: created.agreedPriceExclusiveCents,
        },
      });
      return created;
    });
    return privateJson(visibleFields(actor, view(job), JOB_FIELDS), {
      status: 201,
    });
  };

  /**
   * Details only; status moves go through `changeStatus`. The job is locked
   * and re-read inside the audited transaction, so the editability check and
   * the audit "before" both see the row this update really replaces. Only
   * changed fields are written; a no-op records nothing.
   */
  const update: PolicyHandler<JobContext> = async ({
    actor,
    request,
    context,
  }) => {
    const parsed = UpdateJob.safeParse(await jsonOrNull(request));
    if (!parsed.success) return invalid(parsed.error);
    const owned = await ownJob(db(), actor, (await context.params).id);
    const { dueOn, ...rest } = defined(parsed.data);
    if (rest.locationId !== undefined) {
      const problem = await siteProblem(
        db(),
        actor.companyId,
        owned.customerId,
        rest.locationId,
        { requireActiveCustomer: false },
      );
      if (problem) return fail(400, problem[1], problem[0]);
    }
    const data: Partial<Job> = {
      ...rest,
      ...(dueOn !== undefined
        ? { dueOn: dueOn ? new Date(`${dueOn}T00:00:00Z`) : null }
        : {}),
    };
    return inTransaction(async () => {
      const job = await withAudit(db(), async (tx, audit) => {
        const before = await lockedJob(tx, owned.id);
        if (!isJobEditable(before.status))
          throw new Refusal(
            fail(409, `A ${before.status} job can't be edited`),
          );
        const changed = (Object.keys(data) as (keyof Job)[]).filter(
          (key) => !same(before[key], data[key]),
        );
        if (changed.length === 0) throw new Refusal(jobResponse(actor, before));
        const updated = await tx.job.update({
          where: { id: owned.id },
          data: Object.fromEntries(changed.map((key) => [key, data[key]])),
        });
        const pick = (record: Job) =>
          Object.fromEntries(changed.map((key) => [key, record[key]]));
        await audit({
          companyId: actor.companyId,
          actorUserId: actor.userId,
          action: "job.updated",
          target: { type: "job", id: owned.id },
          before: pick(before),
          after: pick(updated),
        });
        return updated;
      });
      return jobResponse(actor, job);
    });
  };

  /**
   * Move the job along its status machine. A compare-and-set update applies
   * only if the status is still the one we checked, so two concurrent moves
   * can't both apply; every move appends an immutable status event in the
   * same transaction.
   */
  const changeStatus: PolicyHandler<JobContext> = async ({
    actor,
    request,
    context,
  }) => {
    const parsed = ChangeStatus.safeParse(await jsonOrNull(request));
    if (!parsed.success) return invalid(parsed.error);
    const current = await ownJob(db(), actor, (await context.params).id);
    const { to, note } = parsed.data;
    const early = transitionProblem(current.status, to);
    if (early) return fail(409, TRANSITION_MESSAGES[early], "to");
    const job = await withAudit(db(), async (tx, audit) => {
      // Compare-and-set: applies only if nobody moved the job meanwhile.
      const moved = await tx.job.updateMany({
        where: { id: current.id, status: current.status },
        data: { status: to },
      });
      if (moved.count !== 1) throw new StatusRaceError();
      await tx.jobStatusEvent.create({
        data: {
          companyId: actor.companyId,
          jobId: current.id,
          fromStatus: current.status,
          toStatus: to,
          note: note ?? null,
          createdBy: actor.userId,
        },
      });
      await audit({
        companyId: actor.companyId,
        actorUserId: actor.userId,
        action: "job.status_changed",
        target: { type: "job", id: current.id },
        before: { status: current.status },
        after: { status: to },
      });
      return tx.job.findUniqueOrThrow({ where: { id: current.id } });
    }).catch((error: unknown) => {
      if (error instanceof StatusRaceError) return null;
      throw error;
    });
    if (!job)
      return fail(409, "The job changed meanwhile. Reload and try again.");
    return privateJson(visibleFields(actor, view(job), JOB_FIELDS));
  };

  const addVisit: PolicyHandler<JobContext> = async ({
    actor,
    request,
    context,
  }) => {
    const parsed = CreateVisit.safeParse(await jsonOrNull(request));
    if (!parsed.success) return invalid(parsed.error);
    const owned = await ownJob(db(), actor, (await context.params).id);
    const data = defined(parsed.data);
    const startsAt = new Date(data.startsAt);
    const endsAt = data.endsAt ? new Date(data.endsAt) : null;
    if (endsAt && endsAt <= startsAt)
      return fail(400, "The visit must end after it starts", "endsAt");
    return inTransaction(async () => {
      const visit = await withAudit(db(), async (tx, audit) => {
        const job = await lockedJob(tx, owned.id);
        if (!isJobEditable(job.status))
          throw new Refusal(
            fail(409, `A ${job.status} job can't get new visits`),
          );
        const created = await tx.jobVisit.create({
          data: {
            companyId: actor.companyId,
            jobId: job.id,
            startsAt,
            endsAt,
            ...(data.status ? { status: data.status } : {}),
            notes: data.notes ?? null,
            createdBy: actor.userId,
          },
        });
        await audit({
          companyId: actor.companyId,
          actorUserId: actor.userId,
          action: "job_visit.created",
          target: { type: "job_visit", id: created.id },
          after: { jobId: job.id, startsAt, endsAt, status: created.status },
        });
        return created;
      });
      return privateJson(visitView(visit), { status: 201 });
    });
  };

  /** Reschedule, complete or cancel a visit; read and written under the job lock. */
  const updateVisit: PolicyHandler<VisitContext> = async ({
    actor,
    request,
    context,
  }) => {
    const parsed = UpdateVisit.safeParse(await jsonOrNull(request));
    if (!parsed.success) return invalid(parsed.error);
    const { id, visitId } = await context.params;
    const owned = await ownJob(db(), actor, id);
    const safe = uuidOrNull(visitId);
    const data = defined(parsed.data);
    return inTransaction(async () => {
      const visit = await withAudit(db(), async (tx, audit) => {
        const job = await lockedJob(tx, owned.id);
        // A final job's visits are frozen, like the job itself.
        if (!isJobEditable(job.status))
          throw new Refusal(
            fail(409, `A ${job.status} job's visits can't be changed`),
          );
        const before = requireSameCompany(
          actor,
          safe
            ? await tx.jobVisit.findFirst({
                where: { id: safe, jobId: owned.id },
              })
            : null,
        );
        const next = {
          startsAt: data.startsAt ? new Date(data.startsAt) : before.startsAt,
          endsAt:
            data.endsAt === undefined
              ? before.endsAt
              : data.endsAt
                ? new Date(data.endsAt)
                : null,
          status: data.status ?? before.status,
          notes: data.notes === undefined ? before.notes : data.notes,
        };
        if (next.endsAt && next.endsAt <= next.startsAt)
          throw new Refusal(
            fail(400, "The visit must end after it starts", "endsAt"),
          );
        const changed = (Object.keys(next) as (keyof typeof next)[]).filter(
          (key) => !same(before[key], next[key]),
        );
        if (changed.length === 0)
          throw new Refusal(privateJson(visitView(before)));
        const updated = await tx.jobVisit.update({
          where: { id: before.id },
          data: Object.fromEntries(changed.map((key) => [key, next[key]])),
        });
        await audit({
          companyId: actor.companyId,
          actorUserId: actor.userId,
          action: "job_visit.updated",
          target: { type: "job_visit", id: before.id },
          before: Object.fromEntries(changed.map((key) => [key, before[key]])),
          after: Object.fromEntries(changed.map((key) => [key, updated[key]])),
        });
        return updated;
      });
      return privateJson(visitView(visit));
    });
  };

  return { list, read, create, update, changeStatus, addVisit, updateVisit };
}

class StatusRaceError extends Error {}

/** Ends a transaction early with a ready response (nothing is written). */
export class Refusal extends Error {
  constructor(readonly response: Response) {
    super("refused");
  }
}

/** Run a handler body whose transaction may end in a Refusal. */
export async function inTransaction(
  body: () => Promise<Response>,
): Promise<Response> {
  try {
    return await body();
  } catch (error) {
    if (error instanceof Refusal) return error.response;
    throw error;
  }
}

/** Lock the job row for this transaction and return its current state. */
export async function lockedJob(
  tx: Prisma.TransactionClient,
  id: string,
): Promise<Job> {
  await lockRow(tx, "jobs", id);
  return tx.job.findUniqueOrThrow({ where: { id } });
}

/** Value equality for Prisma scalars (Dates, bigints, strings, null). */
function same(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date)
    return a.getTime() === b.getTime();
  return a === b;
}
