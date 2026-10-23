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

const optional = (schema: z.ZodString) =>
  schema
    .nullable()
    .transform((value) => (value && value.trim() ? value.trim() : null));

const fields = {
  name: z.string().trim().min(1, "Enter a name").max(200),
  email: optional(z.string().trim().max(320)).refine(
    (value) => value === null || z.email().safeParse(value).success,
    "Enter a valid email address",
  ),
  phone: optional(
    z
      .string()
      .trim()
      .max(30)
      .regex(/^[+\d][\d\s()-]*$/, "Use digits, spaces, +, - or brackets"),
  ),
  /** A user account of the same company; null unlinks. */
  userId: z.uuid().nullable(),
};

const CreateEmployee = z.object({
  name: fields.name,
  email: fields.email.optional(),
  phone: fields.phone.optional(),
  userId: fields.userId.optional(),
});

const UpdateEmployee = z
  .object({ ...fields, isActive: z.boolean() })
  .partial()
  .refine((value) => Object.keys(value).length > 0, "Nothing to update");

const STATUS = z.enum(["active", "inactive", "all"]).catch("active");

type IdContext = { params: Promise<{ id: string }> };

/** Drop keys whose value is undefined (exactOptionalPropertyTypes). */
function defined<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as { [K in keyof T]: Exclude<T[K], undefined> };
}

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
  return taken ? "That user account is already linked to an employee" : null;
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
    const { id } = await context.params;
    const row = requireSameCompany(
      actor,
      z.uuid().safeParse(id).success
        ? await db().employee.findUnique({ where: { id } })
        : null,
    );
    return privateJson(visibleFields(actor, row, EMPLOYEE_FIELDS));
  };

  const create: PolicyHandler<unknown> = async ({ actor, request }) => {
    const parsed = CreateEmployee.safeParse(await jsonOrNull(request));
    if (!parsed.success) return invalid(parsed.error);
    const data = defined(parsed.data);
    const problem = await linkProblem(db(), actor.companyId, data.userId);
    if (problem)
      return privateJson(
        { error: problem, fields: { userId: problem } },
        { status: 400 },
      );
    const row = await withAudit(db(), async (tx, audit) => {
      const created = await tx.employee.create({
        data: { ...data, companyId: actor.companyId, createdBy: actor.userId },
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
  };

  /** Edit, link/unlink a user, deactivate or reactivate. Never deleted. */
  const update: PolicyHandler<IdContext> = async ({
    actor,
    request,
    context,
  }) => {
    const { id } = await context.params;
    const parsed = UpdateEmployee.safeParse(await jsonOrNull(request));
    if (!parsed.success) return invalid(parsed.error);
    const data = defined(parsed.data);
    const before = requireSameCompany(
      actor,
      z.uuid().safeParse(id).success
        ? await db().employee.findUnique({ where: { id } })
        : null,
    );
    const problem = await linkProblem(db(), actor.companyId, data.userId, id);
    if (problem)
      return privateJson(
        { error: problem, fields: { userId: problem } },
        { status: 400 },
      );
    const keys = Object.keys(data) as (keyof Employee)[];
    const row = await withAudit(db(), async (tx, audit) => {
      const updated = await tx.employee.update({ where: { id }, data });
      const pick = (record: Employee) =>
        Object.fromEntries(keys.map((key) => [key, record[key]]));
      await audit({
        companyId: actor.companyId,
        actorUserId: actor.userId,
        action:
          keys.length === 1 && keys[0] === "isActive"
            ? data.isActive
              ? "employee.reactivated"
              : "employee.deactivated"
            : "employee.updated",
        target: { type: "employee", id },
        before: pick(before),
        after: pick(updated),
      });
      return updated;
    });
    return privateJson(visibleFields(actor, row, EMPLOYEE_FIELDS));
  };

  return { list, read, create, update };
}
