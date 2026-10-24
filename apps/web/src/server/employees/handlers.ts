import {
  type FieldRules,
  companyScope,
  requireSameCompany,
  visibleFields,
} from "@jobflow/authz";
import { z } from "zod";
import type {
  Employee,
  Prisma,
  PrismaClient,
} from "../../../../../packages/database/src/generated/prisma/client";
import { withAudit } from "../../../../../packages/database/src/index";
import { type PolicyHandler, privateJson } from "../authz/policy";
import { invalid, jsonOrNull } from "../company/handlers";
import { isUniqueViolation, lockRow } from "../db/locks";
import {
  defined,
  emailField,
  phoneField,
  requiredText,
  uuidOrNull,
} from "../http/fields";
import { parsePage } from "../http/guards";

/**
 * Positive allowlist. Contact details are for the office (employee.read =
 * owner, manager, accountant); cost rates arrive with timesheets and will
 * need employee.cost_rate.read.
 */
const EMPLOYEE_FIELDS: FieldRules<Employee> = {
  id: true,
  name: true,
  email: true,
  phone: true,
  userId: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
};

const fields = {
  name: requiredText(200, "Enter a name"),
  // Blank email/phone clear the field (shared rules normalise "" to null).
  email: emailField,
  phone: phoneField,
  /** A user account of the same company; null unlinks. */
  userId: z.uuid().nullable(),
};

const CreateEmployee = z.object(fields).partial().required({ name: true });

const UpdateEmployee = z
  .object({ ...fields, isActive: z.boolean() })
  .partial()
  .refine((value) => Object.keys(value).length > 0, "Nothing to update");

const STATUS = z.enum(["active", "inactive", "all"]).catch("active");

type IdContext = { params: Promise<{ id: string }> };

const LINKED = "That user account is already linked to an employee";
const linkError = (message: string) =>
  privateJson({ error: message, fields: { userId: message } }, { status: 400 });

/** The membership exists and is active in this company (or no link at all). */
async function linkProblem(
  db: PrismaClient,
  companyId: string,
  userId: string | null | undefined,
  employeeId?: string,
): Promise<string | null> {
  if (!userId) return null;
  const membership = await db.membership.findUnique({
    where: { companyId_userId: { companyId, userId } },
  });
  if (!membership?.isActive) return "Choose a user account of this company";
  const taken = await db.employee.findFirst({
    where: {
      companyId,
      userId,
      ...(employeeId ? { NOT: { id: employeeId } } : {}),
    },
    select: { id: true },
  });
  return taken ? LINKED : null;
}

/** Audit action for the fields that really changed. */
function actionFor(changed: readonly string[], after: Employee): string {
  if (changed.length === 1 && changed[0] === "isActive")
    return after.isActive ? "employee.reactivated" : "employee.deactivated";
  return "employee.updated";
}

class NothingChanged extends Error {
  constructor(readonly row: Employee) {
    super("nothing changed");
  }
}

export function employeeHandlers(db: () => PrismaClient) {
  const list: PolicyHandler<unknown> = async ({ actor, request }) => {
    const params = new URL(request.url).searchParams;
    const { page, take, skip } = parsePage(params);
    const status = STATUS.parse(params.get("status") ?? undefined);
    const q = params.get("q")?.trim().slice(0, 100);
    const filter: Prisma.EmployeeWhereInput = {
      ...(status === "all" ? {} : { isActive: status === "active" }),
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: "insensitive" } },
              { email: { contains: q, mode: "insensitive" } },
            ],
          }
        : {}),
    };
    // companyScope overrides any companyId: the actor's company always wins.
    const where: Prisma.EmployeeWhereInput = companyScope(actor, filter);
    const [rows, total] = await Promise.all([
      db().employee.findMany({
        where,
        orderBy: [{ name: "asc" }, { id: "asc" }],
        take,
        skip,
      }),
      db().employee.count({ where }),
    ]);
    return privateJson({
      page,
      pageSize: take,
      total,
      employees: rows.map((row) => visibleFields(actor, row, EMPLOYEE_FIELDS)),
    });
  };

  const read: PolicyHandler<IdContext> = async ({ actor, context }) => {
    const id = uuidOrNull((await context.params).id);
    const row = requireSameCompany(
      actor,
      id ? await db().employee.findUnique({ where: { id } }) : null,
    );
    return privateJson(visibleFields(actor, row, EMPLOYEE_FIELDS));
  };

  const create: PolicyHandler<unknown> = async ({ actor, request }) => {
    const parsed = CreateEmployee.safeParse(await jsonOrNull(request));
    if (!parsed.success) return invalid(parsed.error);
    const data = defined(parsed.data);
    const problem = await linkProblem(db(), actor.companyId, data.userId);
    if (problem) return linkError(problem);
    try {
      const row = await withAudit(db(), async (tx, audit) => {
        const created = await tx.employee.create({
          data: {
            ...data,
            companyId: actor.companyId,
            createdBy: actor.userId,
          },
        });
        await audit({
          companyId: actor.companyId,
          actorUserId: actor.userId,
          action: "employee.created",
          target: { type: "employee", id: created.id },
          after: { name: created.name, userId: created.userId },
        });
        return created;
      });
      return privateJson(visibleFields(actor, row, EMPLOYEE_FIELDS), {
        status: 201,
      });
    } catch (error) {
      // A concurrent request linked the same user first.
      if (isUniqueViolation(error, "user_id")) return linkError(LINKED);
      throw error;
    }
  };

  /**
   * Edit, link/unlink a user, deactivate or reactivate. Never deleted. The
   * row is locked and re-read inside the audited transaction, so the audit
   * "before" is exactly what this update replaced; a request that changes
   * nothing records nothing.
   */
  const update: PolicyHandler<IdContext> = async ({
    actor,
    request,
    context,
  }) => {
    const id = uuidOrNull((await context.params).id);
    const parsed = UpdateEmployee.safeParse(await jsonOrNull(request));
    if (!parsed.success) return invalid(parsed.error);
    requireSameCompany(
      actor,
      id ? await db().employee.findUnique({ where: { id } }) : null,
    );
    const employeeId = id as string;
    const data = defined(parsed.data);
    const problem = await linkProblem(
      db(),
      actor.companyId,
      data.userId,
      employeeId,
    );
    if (problem) return linkError(problem);
    try {
      const row = await withAudit(db(), async (tx, audit) => {
        await lockRow(tx, "employees", employeeId);
        const before = await tx.employee.findUniqueOrThrow({
          where: { id: employeeId },
        });
        const changed = (Object.keys(data) as (keyof typeof data)[]).filter(
          (key) => before[key] !== data[key],
        );
        if (changed.length === 0) throw new NothingChanged(before);
        const updated = await tx.employee.update({
          where: { id: employeeId },
          data: Object.fromEntries(changed.map((key) => [key, data[key]])),
        });
        await audit({
          companyId: actor.companyId,
          actorUserId: actor.userId,
          action: actionFor(changed, updated),
          target: { type: "employee", id: employeeId },
          before: Object.fromEntries(changed.map((key) => [key, before[key]])),
          after: Object.fromEntries(changed.map((key) => [key, updated[key]])),
        });
        return updated;
      });
      return privateJson(visibleFields(actor, row, EMPLOYEE_FIELDS));
    } catch (error) {
      if (error instanceof NothingChanged)
        return privateJson(visibleFields(actor, error.row, EMPLOYEE_FIELDS));
      if (isUniqueViolation(error, "user_id")) return linkError(LINKED);
      throw error;
    }
  };

  /**
   * Login accounts an employee record can be linked to (#131): active
   * employee-role members of this company, with the record each is already
   * linked to. Lets owner/manager (employee.write) link a login without
   * user.manage; exposes only name, email and the existing link.
   */
  const linkable: PolicyHandler<unknown> = async ({ actor }) => {
    const members = await db().membership.findMany({
      where: { companyId: actor.companyId, isActive: true, role: "employee" },
      select: { userId: true, user: { select: { name: true, email: true } } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 500,
    });
    const links = await db().employee.findMany({
      where: {
        companyId: actor.companyId,
        userId: { in: members.map((member) => member.userId) },
      },
      select: { id: true, userId: true },
    });
    const linkedTo = new Map(links.map((link) => [link.userId, link.id]));
    return privateJson({
      users: members.map((member) => ({
        userId: member.userId,
        name: member.user.name,
        email: member.user.email,
        employeeId: linkedTo.get(member.userId) ?? null,
      })),
    });
  };

  return { list, read, create, update, linkable };
}
