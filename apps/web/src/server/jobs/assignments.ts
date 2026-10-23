import { type Actor, requireSameCompany } from "@jobflow/authz";
import { isJobEditable } from "@jobflow/domain";
import { z } from "zod";
import type {
  Assignment,
  PrismaClient,
} from "../../../../../packages/database/src/generated/prisma/client";
import { withAudit } from "../../../../../packages/database/src/index";
import { type PolicyHandler, privateJson } from "../authz/policy";
import { invalid, jsonOrNull } from "../company/handlers";
import { uuidOrNull } from "../http/fields";

// #32. Managers (job.assign: owner, manager) assign employees to a job or to
// one of its visits. Unassigning ends the assignment; history is kept.

type JobContext = { params: Promise<{ id: string }> };
type AssignmentContext = {
  params: Promise<{ id: string; assignmentId: string }>;
};

const Assign = z.object({
  employeeId: z.uuid("Choose an employee"),
  visitId: z.uuid().nullable().optional(),
});
const End = z.object({ ended: z.literal(true) });

export function assignmentView(
  row: Assignment & { employee: { name: string } },
) {
  return {
    id: row.id,
    employeeId: row.employeeId,
    employeeName: row.employee.name,
    visitId: row.visitId,
    assignedAt: row.assignedAt,
    endedAt: row.endedAt,
  };
}

const fail = (status: 400 | 409, error: string, field?: string) =>
  privateJson(
    { error, ...(field ? { fields: { [field]: error } } : {}) },
    {
      status,
    },
  );

async function ownJob(db: PrismaClient, actor: Actor, id: string) {
  const safe = uuidOrNull(id);
  return requireSameCompany(
    actor,
    safe ? await db.job.findUnique({ where: { id: safe } }) : null,
  );
}

/** A unique-index violation: the same live assignment already exists. */
function isDuplicate(error: unknown): boolean {
  return /P2002|23505|assignments_live_/.test(
    `${String(error)} ${JSON.stringify(error ?? null)}`,
  );
}

export function assignmentHandlers(db: () => PrismaClient) {
  const assign: PolicyHandler<JobContext> = async ({
    actor,
    request,
    context,
  }) => {
    const parsed = Assign.safeParse(await jsonOrNull(request));
    if (!parsed.success) return invalid(parsed.error);
    const job = await ownJob(db(), actor, (await context.params).id);
    if (!isJobEditable(job.status))
      return fail(409, `A ${job.status} job can't be assigned`);
    const { employeeId, visitId = null } = parsed.data;
    const employee = await db().employee.findFirst({
      where: { id: employeeId, companyId: actor.companyId, isActive: true },
    });
    if (!employee) return fail(400, "Choose an active employee", "employeeId");
    if (visitId) {
      const visit = await db().jobVisit.findFirst({
        where: { id: visitId, companyId: actor.companyId, jobId: job.id },
      });
      if (!visit)
        return fail(400, "Choose one of this job's visits", "visitId");
    }
    try {
      const row = await withAudit(db(), async (tx, audit) => {
        const created = await tx.assignment.create({
          data: {
            companyId: actor.companyId,
            jobId: job.id,
            employeeId,
            visitId,
            createdBy: actor.userId,
          },
          include: { employee: { select: { name: true } } },
        });
        await audit({
          companyId: actor.companyId,
          actorUserId: actor.userId,
          action: "job.assigned",
          target: { type: "job", id: job.id },
          after: { assignmentId: created.id, employeeId, visitId },
        });
        return created;
      });
      return privateJson(assignmentView(row), { status: 201 });
    } catch (error) {
      if (isDuplicate(error))
        return fail(409, `${employee.name} is already assigned here`);
      throw error;
    }
  };

  const end: PolicyHandler<AssignmentContext> = async ({
    actor,
    request,
    context,
  }) => {
    const parsed = End.safeParse(await jsonOrNull(request));
    if (!parsed.success) return invalid(parsed.error);
    const { id, assignmentId } = await context.params;
    const job = await ownJob(db(), actor, id);
    const safe = uuidOrNull(assignmentId);
    const before = requireSameCompany(
      actor,
      safe
        ? await db().assignment.findFirst({
            where: { id: safe, jobId: job.id },
          })
        : null,
    );
    if (before.endedAt) return fail(409, "That assignment has already ended");
    const row = await withAudit(db(), async (tx, audit) => {
      const updated = await tx.assignment.update({
        where: { id: before.id },
        data: { endedAt: new Date(), endedBy: actor.userId },
        include: { employee: { select: { name: true } } },
      });
      await audit({
        companyId: actor.companyId,
        actorUserId: actor.userId,
        action: "job.unassigned",
        target: { type: "job", id: job.id },
        before: { assignmentId: before.id, employeeId: before.employeeId },
      });
      return updated;
    });
    return privateJson(assignmentView(row));
  };

  return { assign, end };
}
