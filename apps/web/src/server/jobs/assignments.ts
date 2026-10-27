import { type Actor, requireSameCompany } from "@jobflow/authz";
import { isJobEditable } from "@jobflow/domain";
import { z } from "zod";
import type { PrismaClient } from "../../../../../packages/database/src/generated/prisma/client";
import { withAudit } from "../../../../../packages/database/src/index";
import { type PolicyHandler, privateJson } from "../authz/policy";
import { invalid, jsonOrNull } from "../company/handlers";
import { lockRow } from "../db/locks";
import { uuidOrNull } from "../http/fields";
import { Refusal, inTransaction, lockedJob } from "./handlers";
import { assignmentView } from "./views";

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
      return await inTransaction(async () => {
        const row = await withAudit(db(), async (tx, audit) => {
          // Status is checked under the job lock, so it can't change meanwhile.
          const current = await lockedJob(tx, job.id, actor.companyId);
          if (!isJobEditable(current.status))
            throw new Refusal(
              fail(409, `A ${current.status} job can't be assigned`),
            );
          if (visitId) {
            const visit = await tx.jobVisit.findFirst({
              where: { id: visitId, jobId: job.id, companyId: actor.companyId },
              select: { status: true },
            });
            if (!visit)
              throw new Refusal(
                fail(400, "Choose one of this job's visits", "visitId"),
              );
            if (visit.status === "cancelled")
              throw new Refusal(
                fail(409, "A cancelled visit can't be assigned", "visitId"),
              );
          }
          // Deactivation uses the same employee row lock. Recheck after taking
          // it so a stale preflight read cannot assign an inactive employee.
          await lockRow(tx, "employees", employeeId, actor.companyId);
          const active = await tx.employee.findFirst({
            where: {
              id: employeeId,
              companyId: actor.companyId,
              isActive: true,
            },
            select: { id: true },
          });
          if (!active)
            throw new Refusal(
              fail(400, "Choose an active employee", "employeeId"),
            );
          const created = await tx.assignment.create({
            data: {
              companyId: actor.companyId,
              jobId: job.id,
              employeeId,
              visitId,
              createdBy: actor.userId,
            },
            include: { employee: { select: { name: true, isActive: true } } },
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
      });
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
    return inTransaction(async () => {
      const row = await withAudit(db(), async (tx, audit) => {
        // Read under the job lock: two concurrent ends can't both apply.
        await lockedJob(tx, job.id, actor.companyId);
        const before = requireSameCompany(
          actor,
          safe
            ? await tx.assignment.findFirst({
                where: { id: safe, jobId: job.id },
              })
            : null,
        );
        if (before.endedAt)
          throw new Refusal(fail(409, "That assignment has already ended"));
        const updated = await tx.assignment.update({
          where: { id: before.id },
          data: { endedAt: new Date(), endedBy: actor.userId },
          include: { employee: { select: { name: true, isActive: true } } },
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
    });
  };

  return { assign, end };
}
