import {
  type Actor,
  can,
  companyScope,
  requireSameCompany,
} from "@jobflow/authz";
import { MAX_TIMESHEET_MINUTES, labourCost, rateOn } from "@jobflow/domain";
import { z } from "zod";
import type {
  Prisma,
  PrismaClient,
  Timesheet,
} from "../../../../../packages/database/src/generated/prisma/client";
import { withAudit } from "../../../../../packages/database/src/index";
import { type PolicyHandler, privateJson } from "../authz/policy";
import { invalid, jsonOrNull } from "../company/handlers";
import { sydneyToday, toDay } from "../company/gst";
import { isUniqueViolation, lockRow } from "../db/locks";
import { optionalText, requiredText, uuidOrNull } from "../http/fields";
import { parsePage } from "../http/guards";
import { Refusal, inTransaction } from "../jobs/handlers";

// #38. Submit: timesheet.submit_own (employees, owner) for jobs or visits
// they're live-assigned to. Read all and decide: timesheet.approve (owner,
// manager). Rates and costs only with employee.cost_rate.read. Cost is
// incurred once, on approval, at the rate in effect on the work date.

const day = z.iso.date("Use a date like 2026-07-01");
const minutes = z
  .number()
  .int("Whole minutes only")
  .min(1, "Enter at least 1 minute")
  .max(MAX_TIMESHEET_MINUTES, "At most 24 hours per timesheet");

const fields = {
  jobId: z.uuid("Choose a job"),
  visitId: z.uuid().nullable(),
  workDate: day,
  minutes,
  note: optionalText(500),
};
const CreateTimesheet = z
  .object(fields)
  .partial()
  .required({ jobId: true, workDate: true, minutes: true });
const UpdateTimesheet = z
  .object(fields)
  .omit({ jobId: true })
  .partial()
  .refine((value) => Object.keys(value).length > 0, "Nothing to update");
const Decide = z.object({
  decision: z.enum(["approve", "reject"]),
  note: optionalText(500).optional(),
});
const Reverse = z.object({ note: requiredText(500, "Say why it's reversed") });
const STATUS = z
  .enum(["submitted", "approved", "rejected"])
  .optional()
  .catch(undefined);

type IdContext = { params: Promise<{ id: string }> };

const fail = (status: 400 | 409, error: string, field?: string) =>
  privateJson(
    { error, ...(field ? { fields: { [field]: error } } : {}) },
    { status },
  );

const money = (value: bigint | null) =>
  value === null ? null : value.toString();
const fromDay = (value: string) => new Date(`${value}T00:00:00Z`);

/** What the submitter entered and its status: no rate or cost. */
function ownView(row: Timesheet) {
  return {
    id: row.id,
    jobId: row.jobId,
    visitId: row.visitId,
    workDate: toDay(row.workDate),
    minutes: row.minutes,
    note: row.note,
    status: row.status,
    decisionNote: row.decisionNote,
    decidedAt: row.decidedAt,
    reversesId: row.reversesId,
    createdAt: row.createdAt,
  };
}

type OfficeRow = Timesheet & {
  employee: { name: string };
  reversedBy: { id: string } | null;
};
const OFFICE_INCLUDE = {
  employee: { select: { name: true } },
  reversedBy: { select: { id: true } },
} as const;

/** Office view; the rate and cost only with employee.cost_rate.read. */
function officeView(actor: Actor, row: OfficeRow) {
  return {
    ...ownView(row),
    employeeId: row.employeeId,
    employeeName: row.employee.name,
    submittedBy: row.submittedBy,
    decidedBy: row.decidedBy,
    reversedById: row.reversedBy?.id ?? null,
    ...(can(actor.role, "employee.cost_rate.read")
      ? {
          hourlyCostCents: money(row.hourlyCostCents),
          costCents: money(row.costCents),
        }
      : {}),
  };
}

/**
 * The caller's own active employee record, locked after the job (#32 lock
 * order: job, then employee), with its live assignments on that job.
 */
async function lockedSubmitter(
  tx: Prisma.TransactionClient,
  actor: Actor,
  jobId: string,
) {
  await lockRow(tx, "jobs", jobId, actor.companyId);
  const employee = await tx.employee.findFirst({
    where: { companyId: actor.companyId, userId: actor.userId },
  });
  if (!employee) return null;
  await lockRow(tx, "employees", employee.id, actor.companyId);
  const current = await tx.employee.findUniqueOrThrow({
    where: { id: employee.id },
    include: {
      assignments: {
        where: { jobId, endedAt: null },
        select: { visitId: true },
      },
    },
  });
  return current.isActive ? current : null;
}

/**
 * Checks shared by submit and edit, under the locks. A whole-job assignment
 * covers the job and all its visits; a visit-only one covers that visit.
 */
async function eligibility(
  tx: Prisma.TransactionClient,
  actor: Actor,
  draft: { jobId: string; visitId: string | null; workDate: string },
): Promise<[string, string] | { employeeId: string }> {
  if (draft.workDate > sydneyToday())
    return ["workDate", "The work date can't be in the future"];
  const job = await tx.job.findFirst({
    where: { id: draft.jobId, companyId: actor.companyId },
    select: { id: true },
  });
  if (!job) return ["jobId", "Choose one of your assigned jobs"];
  const employee = await lockedSubmitter(tx, actor, job.id);
  if (!employee) return ["jobId", "Choose one of your assigned jobs"];
  const wholeJob = employee.assignments.some((a) => a.visitId === null);
  if (draft.visitId) {
    const visit = await tx.jobVisit.findFirst({
      where: { id: draft.visitId, jobId: job.id, companyId: actor.companyId },
      select: { status: true },
    });
    if (!visit) return ["visitId", "Choose one of this job's visits"];
    if (visit.status === "cancelled")
      return ["visitId", "Time can't be logged on a cancelled visit"];
    if (
      !wholeJob &&
      !employee.assignments.some((a) => a.visitId === draft.visitId)
    )
      return ["visitId", "Choose a visit you're assigned to"];
  } else if (!wholeJob) {
    return ["visitId", "Choose the visit you're assigned to"];
  }
  return { employeeId: employee.id };
}

async function lockedTimesheet(
  tx: Prisma.TransactionClient,
  id: string,
  companyId: string,
) {
  await lockRow(tx, "timesheets", id, companyId);
  return tx.timesheet.findUniqueOrThrow({
    where: { id },
    include: OFFICE_INCLUDE,
  });
}

async function ownTimesheet(db: PrismaClient, actor: Actor, id: string) {
  const safe = uuidOrNull(id);
  return requireSameCompany(
    actor,
    safe ? await db.timesheet.findUnique({ where: { id: safe } }) : null,
  );
}

export function timesheetHandlers(db: () => PrismaClient) {
  const list: PolicyHandler<unknown> = async ({ actor, request }) => {
    const params = new URL(request.url).searchParams;
    const { page, take, skip } = parsePage(params);
    const status = STATUS.parse(params.get("status") ?? undefined);
    const jobId = uuidOrNull(params.get("jobId") ?? "");
    const employeeId = uuidOrNull(params.get("employeeId") ?? "");
    const filter: Prisma.TimesheetWhereInput = {
      ...(status ? { status } : {}),
      ...(jobId ? { jobId } : {}),
      ...(employeeId ? { employeeId } : {}),
    };
    const where: Prisma.TimesheetWhereInput = companyScope(actor, filter);
    const [rows, total] = await Promise.all([
      db().timesheet.findMany({
        where,
        include: OFFICE_INCLUDE,
        orderBy: [{ workDate: "desc" }, { createdAt: "desc" }, { id: "asc" }],
        take,
        skip,
      }),
      db().timesheet.count({ where }),
    ]);
    return privateJson({
      page,
      pageSize: take,
      total,
      timesheets: rows.map((row) => officeView(actor, row)),
    });
  };

  /** The caller's own submissions (newest first). */
  const mine: PolicyHandler<unknown> = async ({ actor, request }) => {
    const { page, take, skip } = parsePage(new URL(request.url).searchParams);
    const where = {
      companyId: actor.companyId,
      submittedBy: actor.userId,
      reversesId: null,
    };
    const [rows, total] = await Promise.all([
      db().timesheet.findMany({
        where,
        orderBy: [{ workDate: "desc" }, { createdAt: "desc" }, { id: "asc" }],
        take,
        skip,
      }),
      db().timesheet.count({ where }),
    ]);
    return privateJson({
      page,
      pageSize: take,
      total,
      timesheets: rows.map(ownView),
    });
  };

  /** Log time on an assigned job or visit; eligibility checked under the locks. */
  const create: PolicyHandler<unknown> = async ({ actor, request }) => {
    const parsed = CreateTimesheet.safeParse(await jsonOrNull(request));
    if (!parsed.success) return invalid(parsed.error);
    const data = parsed.data;
    const visitId = data.visitId ?? null;
    return inTransaction(async () => {
      const row = await withAudit(db(), async (tx, audit) => {
        const checked = await eligibility(tx, actor, {
          jobId: data.jobId,
          visitId,
          workDate: data.workDate,
        });
        if (Array.isArray(checked))
          throw new Refusal(fail(400, checked[1], checked[0]));
        const created = await tx.timesheet.create({
          data: {
            companyId: actor.companyId,
            employeeId: checked.employeeId,
            jobId: data.jobId,
            visitId,
            workDate: fromDay(data.workDate),
            minutes: data.minutes,
            note: data.note ?? null,
            submittedBy: actor.userId,
          },
        });
        await audit({
          companyId: actor.companyId,
          actorUserId: actor.userId,
          action: "timesheet.submitted",
          target: { type: "timesheet", id: created.id },
          after: {
            jobId: created.jobId,
            visitId: created.visitId,
            workDate: data.workDate,
            minutes: created.minutes,
          },
        });
        return created;
      });
      return privateJson(ownView(row), { status: 201 });
    });
  };

  /** The submitter edits their own timesheet until it is decided. */
  const update: PolicyHandler<IdContext> = async ({
    actor,
    request,
    context,
  }) => {
    const parsed = UpdateTimesheet.safeParse(await jsonOrNull(request));
    if (!parsed.success) return invalid(parsed.error);
    const owned = await ownTimesheet(db(), actor, (await context.params).id);
    // Someone else's timesheet is "not found".
    if (owned.submittedBy !== actor.userId) requireSameCompany(actor, null);
    const data = parsed.data;
    return inTransaction(async () => {
      const row = await withAudit(db(), async (tx, audit) => {
        const before = await lockedTimesheet(tx, owned.id, actor.companyId);
        if (before.status !== "submitted")
          throw new Refusal(
            fail(409, `A ${before.status} timesheet can't be changed`),
          );
        const next = {
          visitId: data.visitId === undefined ? before.visitId : data.visitId,
          workDate: data.workDate ?? toDay(before.workDate),
          minutes: data.minutes ?? before.minutes,
          note: data.note === undefined ? before.note : data.note,
        };
        const checked = await eligibility(tx, actor, {
          jobId: before.jobId,
          visitId: next.visitId,
          workDate: next.workDate,
        });
        if (Array.isArray(checked))
          throw new Refusal(fail(400, checked[1], checked[0]));
        const values = {
          visitId: next.visitId,
          workDate: fromDay(next.workDate),
          minutes: next.minutes,
          note: next.note,
        };
        const changed = (Object.keys(values) as (keyof typeof values)[]).filter(
          (key) =>
            key === "workDate"
              ? toDay(before.workDate) !== next.workDate
              : before[key] !== values[key],
        );
        if (changed.length === 0)
          throw new Refusal(privateJson(ownView(before)));
        const updated = await tx.timesheet.update({
          where: { id: before.id },
          data: Object.fromEntries(changed.map((key) => [key, values[key]])),
        });
        await audit({
          companyId: actor.companyId,
          actorUserId: actor.userId,
          action: "timesheet.updated",
          target: { type: "timesheet", id: before.id },
          before: Object.fromEntries(changed.map((key) => [key, before[key]])),
          after: Object.fromEntries(changed.map((key) => [key, updated[key]])),
        });
        return updated;
      });
      return privateJson(ownView(row));
    });
  };

  /**
   * Approve or reject. Approval snapshots the rate in effect on the work date
   * and the cost once; no rate on that date is a 409, not a guess.
   */
  const decide: PolicyHandler<IdContext> = async ({
    actor,
    request,
    context,
  }) => {
    const parsed = Decide.safeParse(await jsonOrNull(request));
    if (!parsed.success) return invalid(parsed.error);
    const owned = await ownTimesheet(db(), actor, (await context.params).id);
    const { decision, note } = parsed.data;
    return inTransaction(async () => {
      const row = await withAudit(db(), async (tx, audit) => {
        const before = await lockedTimesheet(tx, owned.id, actor.companyId);
        if (before.status !== "submitted")
          throw new Refusal(
            fail(409, `This timesheet is already ${before.status}`),
          );
        const decided = {
          decisionNote: note ?? null,
          decidedAt: new Date(),
          decidedBy: actor.userId,
        };
        if (decision === "reject") {
          const updated = await tx.timesheet.update({
            where: { id: before.id },
            data: { status: "rejected", ...decided },
            include: OFFICE_INCLUDE,
          });
          await audit({
            companyId: actor.companyId,
            actorUserId: actor.userId,
            action: "timesheet.rejected",
            target: { type: "timesheet", id: before.id },
            before: { status: before.status },
            after: { status: updated.status },
          });
          return updated;
        }
        const rates = await tx.employeeRate.findMany({
          where: { companyId: actor.companyId, employeeId: before.employeeId },
        });
        const rate = rateOn(
          rates.map((entry) => ({
            id: entry.id,
            effectiveFrom: toDay(entry.effectiveFrom),
            hourlyCost: entry.hourlyCostCents,
          })),
          toDay(before.workDate),
        );
        if (!rate)
          throw new Refusal(
            fail(
              409,
              `Set ${before.employee.name}'s cost rate for ${toDay(before.workDate)} before approving`,
            ),
          );
        const cost = labourCost(before.minutes, rate.hourlyCost);
        const updated = await tx.timesheet.update({
          where: { id: before.id },
          data: {
            status: "approved",
            ...decided,
            rateId: rate.id,
            hourlyCostCents: rate.hourlyCost,
            costCents: cost,
          },
          include: OFFICE_INCLUDE,
        });
        await audit({
          companyId: actor.companyId,
          actorUserId: actor.userId,
          action: "timesheet.approved",
          target: { type: "timesheet", id: before.id },
          before: { status: before.status },
          after: {
            status: updated.status,
            rateId: rate.id,
            hourlyCostCents: rate.hourlyCost,
            costCents: cost,
          },
        });
        return updated;
      });
      return privateJson(officeView(actor, row));
    });
  };

  /**
   * Cancel an approved timesheet with an approved reversal: negated minutes
   * and cost at the same snapshotted rate, at most one per timesheet.
   */
  const reverse: PolicyHandler<IdContext> = async ({
    actor,
    request,
    context,
  }) => {
    const parsed = Reverse.safeParse(await jsonOrNull(request));
    if (!parsed.success) return invalid(parsed.error);
    const owned = await ownTimesheet(db(), actor, (await context.params).id);
    return inTransaction(async () => {
      const row = await withAudit(db(), async (tx, audit) => {
        const original = await lockedTimesheet(tx, owned.id, actor.companyId);
        if (original.status !== "approved" || original.reversesId)
          throw new Refusal(
            fail(409, "Only an approved timesheet can be reversed"),
          );
        if (original.reversedBy)
          throw new Refusal(fail(409, "This timesheet is already reversed"));
        const now = new Date();
        const created = await tx.timesheet.create({
          data: {
            companyId: actor.companyId,
            employeeId: original.employeeId,
            jobId: original.jobId,
            visitId: original.visitId,
            workDate: original.workDate,
            minutes: -original.minutes,
            note: original.note,
            status: "approved",
            decisionNote: parsed.data.note,
            decidedAt: now,
            decidedBy: actor.userId,
            rateId: original.rateId,
            hourlyCostCents: original.hourlyCostCents,
            costCents: -(original.costCents ?? 0n),
            reversesId: original.id,
            submittedBy: actor.userId,
          },
          include: OFFICE_INCLUDE,
        });
        await audit({
          companyId: actor.companyId,
          actorUserId: actor.userId,
          action: "timesheet.reversed",
          target: { type: "timesheet", id: original.id },
          after: { reversalId: created.id, costCents: created.costCents },
        });
        return created;
      });
      return privateJson(officeView(actor, row), { status: 201 });
    });
  };

  return { list, mine, create, update, decide, reverse };
}

/**
 * Rate history routes: read with employee.cost_rate.read, add with
 * employee.write (owner, manager; both also read rates).
 */
export function rateHandlers(db: () => PrismaClient) {
  const AddRate = z.object({
    effectiveFrom: day,
    hourlyCostCents: z
      .union([
        z.string().regex(/^\d{1,9}$/, "Whole cents only"),
        z.number().int(),
      ])
      .transform((value, context) => {
        const amount = BigInt(value);
        if (amount < 0n || amount > 100_000_000n) {
          context.addIssue({
            code: "custom",
            message: "Enter $0 to $1,000,000 an hour",
          });
          return z.NEVER;
        }
        return amount;
      }),
  });

  async function ownEmployee(actor: Actor, id: string) {
    const safe = uuidOrNull(id);
    return requireSameCompany(
      actor,
      safe ? await db().employee.findUnique({ where: { id: safe } }) : null,
    );
  }

  const view = (row: {
    id: string;
    effectiveFrom: Date;
    hourlyCostCents: bigint;
    createdAt: Date;
    createdBy: string;
  }) => ({
    id: row.id,
    effectiveFrom: toDay(row.effectiveFrom),
    hourlyCostCents: row.hourlyCostCents.toString(),
    createdAt: row.createdAt,
    createdBy: row.createdBy,
  });

  /** Newest start date first. */
  const list: PolicyHandler<IdContext> = async ({ actor, context }) => {
    const employee = await ownEmployee(actor, (await context.params).id);
    const rows = await db().employeeRate.findMany({
      where: { companyId: actor.companyId, employeeId: employee.id },
      orderBy: [{ effectiveFrom: "desc" }],
    });
    return privateJson({ rates: rows.map(view) });
  };

  /**
   * Append a rate from a start date. Approved timesheets keep their snapshot;
   * a rate is never edited or removed (a correction is a new start date).
   */
  const add: PolicyHandler<IdContext> = async ({ actor, request, context }) => {
    const parsed = AddRate.safeParse(await jsonOrNull(request));
    if (!parsed.success) return invalid(parsed.error);
    const employee = await ownEmployee(actor, (await context.params).id);
    const { effectiveFrom, hourlyCostCents } = parsed.data;
    try {
      const row = await withAudit(db(), async (tx, audit) => {
        const created = await tx.employeeRate.create({
          data: {
            companyId: actor.companyId,
            employeeId: employee.id,
            effectiveFrom: fromDay(effectiveFrom),
            hourlyCostCents,
            createdBy: actor.userId,
          },
        });
        await audit({
          companyId: actor.companyId,
          actorUserId: actor.userId,
          action: "employee.rate_added",
          target: { type: "employee", id: employee.id },
          after: { rateId: created.id, effectiveFrom, hourlyCostCents },
        });
        return created;
      });
      return privateJson(view(row), { status: 201 });
    } catch (error) {
      if (isUniqueViolation(error, "employee_rate_history_employee_from_key"))
        return fail(409, "A rate already starts on that date", "effectiveFrom");
      throw error;
    }
  };

  return { list, add };
}
