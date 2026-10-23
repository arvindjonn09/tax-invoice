import { requireSameCompany } from "@jobflow/authz";
import {
  type GstRegistrationPeriod,
  type GstStatusOnDate,
  type PeriodProblem,
  gstStatusOn,
  registrationProblem,
} from "@jobflow/domain";
import { z } from "zod";
import type {
  CompanyGstRegistration,
  PrismaClient,
} from "../../../../../packages/database/src/generated/prisma/client";
import { withAudit } from "../../../../../packages/database/src/index";
import { type PolicyHandler, privateJson } from "../authz/policy";
import { invalid, jsonOrNull } from "./handlers";

/** "YYYY-MM-DD" ⇄ Postgres DATE (Prisma gives UTC midnight). */
export const toDay = (date: Date): string => date.toISOString().slice(0, 10);
const fromDay = (day: string): Date => new Date(`${day}T00:00:00Z`);

/** Today's business date in Australia/Sydney. */
export function sydneyToday(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
  }).format(now);
}

function period(row: CompanyGstRegistration): GstRegistrationPeriod {
  return {
    startsOn: toDay(row.startsOn),
    endsOn: row.endsOn ? toDay(row.endsOn) : null,
    basis: row.basis,
  };
}

function present(row: CompanyGstRegistration) {
  return { id: row.id, ...period(row) };
}

/**
 * Is the company registered for GST on `date`, and on which basis? The single
 * source for invoices (Tax Invoice vs Invoice), GST on lines and BAS attribution.
 */
export async function companyGstStatusOn(
  db: Pick<PrismaClient, "companyGstRegistration">,
  companyId: string,
  date: string,
): Promise<GstStatusOnDate> {
  const rows = await db.companyGstRegistration.findMany({
    where: { companyId },
  });
  return gstStatusOn(rows.map(period), date);
}

const day = z.iso.date("Use a date like 2026-07-01");

const NewRegistration = z.object({
  startsOn: day,
  endsOn: day.nullable().default(null),
  basis: z.enum(["cash", "non_cash"]),
});

const ChangeRegistration = z
  .object({ endsOn: day.nullable(), basis: z.enum(["cash", "non_cash"]) })
  .partial()
  .refine((value) => Object.keys(value).length > 0, "Nothing to update");

const SetBasPeriod = z.object({ basPeriod: z.enum(["monthly", "quarterly"]) });

const PROBLEMS = {
  "invalid-date": "Enter real calendar dates",
  "ends-before-start": "The end date must be on or after the start date",
  overlap: "This period overlaps another GST registration period",
} as const;

/** The database exclusion constraint caught a concurrent overlapping insert. */
function isOverlapViolation(error: unknown): boolean {
  const text = `${String(error)} ${JSON.stringify(error ?? null)}`;
  return /23P01|company_gst_registrations_no_overlap/.test(text);
}

/** Overlap is a conflict with existing data (409); bad dates are 400. */
function problemResponse(problem: PeriodProblem): Response {
  return privateJson(
    { error: PROBLEMS[problem] },
    { status: problem === "overlap" ? 409 : 400 },
  );
}

export function gstHandlers(db: () => PrismaClient) {
  /** Settings, every registration period and today's status (owner, accountant). */
  const read: PolicyHandler<unknown> = async ({ actor }) => {
    const [company, rows] = await Promise.all([
      db().company.findUniqueOrThrow({
        where: { id: actor.companyId },
        select: { basPeriod: true },
      }),
      db().companyGstRegistration.findMany({
        where: { companyId: actor.companyId },
        orderBy: { startsOn: "asc" },
      }),
    ]);
    const today = sydneyToday();
    return privateJson({
      basPeriod: company.basPeriod,
      registrations: rows.map(present),
      today: { date: today, ...gstStatusOn(rows.map(period), today) },
    });
  };

  const setBasPeriod: PolicyHandler<unknown> = async ({ actor, request }) => {
    const parsed = SetBasPeriod.safeParse(await jsonOrNull(request));
    if (!parsed.success) return invalid(parsed.error);
    const basPeriod = await withAudit(db(), async (tx, audit) => {
      const before = await tx.company.findUniqueOrThrow({
        where: { id: actor.companyId },
        select: { basPeriod: true },
      });
      await tx.company.update({
        where: { id: actor.companyId },
        data: parsed.data,
      });
      await audit({
        companyId: actor.companyId,
        actorUserId: actor.userId,
        action: "gst_settings.bas_period_changed",
        target: { type: "company", id: actor.companyId },
        before,
        after: parsed.data,
      });
      return parsed.data.basPeriod;
    });
    return privateJson({ basPeriod });
  };

  const addRegistration: PolicyHandler<unknown> = async ({
    actor,
    request,
  }) => {
    const parsed = NewRegistration.safeParse(await jsonOrNull(request));
    if (!parsed.success) return invalid(parsed.error);
    const candidate = parsed.data;
    // Validate first (withAudit rejects transactions without an event); the
    // exclusion constraint still catches a concurrent overlapping insert.
    const existing = await db().companyGstRegistration.findMany({
      where: { companyId: actor.companyId },
    });
    const problem = registrationProblem(candidate, existing.map(period));
    if (problem) return problemResponse(problem);
    try {
      const row = await withAudit(db(), async (tx, audit) => {
        const created = await tx.companyGstRegistration.create({
          data: {
            companyId: actor.companyId,
            createdBy: actor.userId,
            startsOn: fromDay(candidate.startsOn),
            endsOn: candidate.endsOn ? fromDay(candidate.endsOn) : null,
            basis: candidate.basis,
          },
        });
        await audit({
          companyId: actor.companyId,
          actorUserId: actor.userId,
          action: "gst_settings.registration_added",
          target: { type: "company_gst_registration", id: created.id },
          after: period(created),
        });
        return created;
      });
      return privateJson(present(row), { status: 201 });
    } catch (error) {
      if (isOverlapViolation(error)) return problemResponse("overlap");
      throw error;
    }
  };

  /**
   * End a registration or correct its basis. To change basis from a date, end
   * the current period and add a new one. Edits will be refused for days in a
   * finalised BAS period once period locks exist (#55).
   */
  const changeRegistration: PolicyHandler<{
    params: Promise<{ id: string }>;
  }> = async ({ actor, request, context }) => {
    const { id } = await context.params;
    const parsed = ChangeRegistration.safeParse(await jsonOrNull(request));
    if (!parsed.success) return invalid(parsed.error);
    const row = requireSameCompany(
      actor,
      z.uuid().safeParse(id).success
        ? await db().companyGstRegistration.findUnique({ where: { id } })
        : null,
    );
    const others = await db().companyGstRegistration.findMany({
      where: { companyId: actor.companyId, NOT: { id } },
    });
    const { endsOn, basis } = parsed.data;
    const current = period(row);
    const problem = registrationProblem(
      {
        startsOn: current.startsOn,
        endsOn: endsOn === undefined ? current.endsOn : endsOn,
        basis: basis ?? current.basis,
      },
      others.map(period),
    );
    if (problem) return problemResponse(problem);
    try {
      const updated = await withAudit(db(), async (tx, audit) => {
        const before = await tx.companyGstRegistration.findUniqueOrThrow({
          where: { id },
        });
        const after = await tx.companyGstRegistration.update({
          where: { id },
          data: {
            ...(basis ? { basis } : {}),
            ...(endsOn !== undefined
              ? { endsOn: endsOn ? fromDay(endsOn) : null }
              : {}),
          },
        });
        await audit({
          companyId: actor.companyId,
          actorUserId: actor.userId,
          action: "gst_settings.registration_changed",
          target: { type: "company_gst_registration", id },
          before: period(before),
          after: period(after),
        });
        return after;
      });
      return privateJson(present(updated));
    } catch (error) {
      if (isOverlapViolation(error)) return problemResponse("overlap");
      throw error;
    }
  };

  return { read, setBasPeriod, addRegistration, changeRegistration };
}
