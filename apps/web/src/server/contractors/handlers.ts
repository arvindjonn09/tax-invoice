import {
  type Actor,
  type FieldRules,
  companyScope,
  notFound,
  requireSameCompany,
  visibleFields,
} from "@jobflow/authz";
import {
  TAX_CODES,
  type TaxCode,
  committedJobCost,
  isJobEditable,
  offerLine,
} from "@jobflow/domain";
import { z } from "zod";
import type {
  Contractor,
  ContractorAcceptance,
  ContractorOffer,
  Job,
  Prisma,
  PrismaClient,
} from "../../../../../packages/database/src/generated/prisma/client";
import { withAudit } from "../../../../../packages/database/src/index";
import { type PolicyHandler, privateJson } from "../authz/policy";
import { invalid, jsonOrNull } from "../company/handlers";
import { companyGstStatusOn, sydneyToday } from "../company/gst";
import { isUniqueViolation, lockRow } from "../db/locks";
import {
  abnField,
  defined,
  emailField,
  optionalText,
  phoneField,
  requiredText,
  uuidOrNull,
} from "../http/fields";
import { parsePage } from "../http/guards";
import { Refusal, inTransaction, lockedJob } from "../jobs/handlers";

// #35. Office: contractor.read (owner, manager, accountant) and
// contractor.write (owner, manager). A subcontractor sees and answers only the
// offers made to the contractor record linked to their own login
// (offer.read_own / offer.respond_own) and never the job's price, the
// company's committed cost or other contractors' rates.

const CONTRACTOR_FIELDS: FieldRules<Contractor> = {
  id: true,
  name: true,
  abn: true,
  gstRegistered: true,
  email: true,
  phone: true,
  userId: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
};

const contractorFields = {
  name: requiredText(200, "Enter the contractor's name"),
  abn: abnField,
  gstRegistered: z.boolean(),
  email: emailField,
  phone: phoneField,
  /** A subcontractor login of the same company; null unlinks. */
  userId: z.uuid().nullable(),
};
const CreateContractor = z
  .object(contractorFields)
  .partial()
  .required({ name: true });
const UpdateContractor = z
  .object({ ...contractorFields, archived: z.boolean() })
  .partial()
  .refine((value) => Object.keys(value).length > 0, "Nothing to update");

/** GST-exclusive cents as a non-negative integer (number or digit string). */
const cents = z
  .union([z.string().regex(/^\d{1,13}$/, "Whole cents only"), z.number().int()])
  .transform((value, context) => {
    const amount = BigInt(value);
    if (amount < 0n || amount > 1_000_000_000_000n) {
      context.addIssue({ code: "custom", message: "Enter a rate from $0" });
      return z.NEVER;
    }
    return amount;
  });

/** "7.5" hours → 750 hundredths; 0.01 to 9999.99 hours. */
const hours = z
  .string()
  .trim()
  .regex(/^\d{1,4}(\.\d{1,2})?$/, "Enter hours like 7.5")
  .transform((value, context) => {
    const [whole = "0", fraction = ""] = value.split(".");
    const hundredths = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
    if (hundredths < 1) {
      context.addIssue({ code: "custom", message: "Enter more than 0 hours" });
      return z.NEVER;
    }
    return hundredths;
  });

const offerFields = {
  contractorId: z.uuid("Choose a contractor"),
  scope: requiredText(2000, "Describe the work"),
  rateType: z.enum(["fixed", "hourly"]),
  rateExclusiveCents: cents,
  estimatedHours: hours.nullable(),
  taxCode: z.enum(TAX_CODES as [TaxCode, ...TaxCode[]]),
};
const CreateOffer = z.object(offerFields).partial().required({
  contractorId: true,
  scope: true,
  rateType: true,
  rateExclusiveCents: true,
  taxCode: true,
});
const UpdateOffer = z
  .object({
    ...offerFields,
    status: z.literal("withdrawn"),
    note: optionalText(500),
  })
  .omit({ contractorId: true })
  .partial()
  .refine((value) => Object.keys(value).length > 0, "Nothing to update");
const Respond = z.object({
  decision: z.enum(["accept", "decline"]),
  note: optionalText(500).optional(),
});

const STATUS = z.enum(["active", "archived", "all"]).catch("active");

type IdContext = { params: Promise<{ id: string }> };
type OfferContext = { params: Promise<{ id: string; offerId: string }> };

const fail = (status: 400 | 409, error: string, field?: string) =>
  privateJson(
    { error, ...(field ? { fields: { [field]: error } } : {}) },
    { status },
  );

const LINKED = "That login is already linked to a contractor";
const LIVE_OFFER =
  "This contractor already has an open or accepted offer on this job";

type Terms = Pick<
  ContractorOffer,
  "rateType" | "rateExclusiveCents" | "estimatedHoursHundredths" | "taxCode"
>;

/** The offer's GST line, or a field error when the terms are inconsistent. */
function priced(terms: Terms, contractor: Pick<Contractor, "gstRegistered">) {
  try {
    return {
      line: offerLine({
        rateType: terms.rateType,
        rateExclusive: terms.rateExclusiveCents,
        estimatedHoursHundredths:
          terms.estimatedHoursHundredths === null
            ? null
            : BigInt(terms.estimatedHoursHundredths),
        taxCode: terms.taxCode,
        contractorRegistered: contractor.gstRegistered,
      }),
    } as const;
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    if (/not registered/.test(error.message))
      return {
        problem: [
          "taxCode",
          "This contractor isn't registered for GST, so they can't charge it",
        ],
      } as const;
    return {
      problem: [
        "estimatedHours",
        terms.rateType === "hourly"
          ? "Enter the estimated hours for an hourly rate"
          : "A fixed price has no estimated hours",
      ],
    } as const;
  }
}

/** Money leaves the API as integer-cent strings: exact, never floats. */
const money = (value: bigint) => value.toString();
const hoursText = (hundredths: number | null) =>
  hundredths === null ? null : (hundredths / 100).toFixed(2);

/**
 * Terms and GST amounts both the office and the contractor may see. An
 * accepted offer shows its acceptance snapshot, never a recalculation from
 * the contractor's current details; an open one is priced live.
 */
function termsView(offer: OfficeOffer) {
  const accepted = offer.acceptance;
  const result = accepted ? null : priced(offer, offer.contractor);
  const line = result && "line" in result ? result.line : null;
  const amounts = accepted
    ? {
        exclusiveCents: money(accepted.exclusiveCents),
        gstCents: money(accepted.gstCents),
        inclusiveCents: money(accepted.inclusiveCents),
      }
    : {
        exclusiveCents: line ? money(line.exclusive) : null,
        gstCents: line ? money(line.gst) : null,
        inclusiveCents: line ? money(line.inclusive) : null,
      };
  const terms = accepted ?? offer;
  return {
    id: offer.id,
    jobId: offer.jobId,
    contractorId: offer.contractorId,
    scope: offer.scope,
    rateType: terms.rateType,
    rateExclusiveCents: money(terms.rateExclusiveCents),
    estimatedHours: hoursText(terms.estimatedHoursHundredths),
    taxCode: terms.taxCode,
    ...amounts,
    status: offer.status,
    responseNote: offer.responseNote,
    respondedAt: offer.respondedAt,
    createdAt: offer.createdAt,
  };
}

/** Accepted terms exactly as snapshotted (never recalculated). */
function acceptanceView(acceptance: ContractorAcceptance) {
  return {
    rateType: acceptance.rateType,
    rateExclusiveCents: money(acceptance.rateExclusiveCents),
    estimatedHours: hoursText(acceptance.estimatedHoursHundredths),
    taxCode: acceptance.taxCode,
    exclusiveCents: money(acceptance.exclusiveCents),
    gstCents: money(acceptance.gstCents),
    inclusiveCents: money(acceptance.inclusiveCents),
    acceptedAt: acceptance.acceptedAt,
  };
}

type OfficeOffer = ContractorOffer & {
  contractor: Contractor;
  acceptance: ContractorAcceptance | null;
};

/** Office view: adds the contractor's name and the committed cost. */
function officeOfferView(offer: OfficeOffer) {
  return {
    ...termsView(offer),
    contractorName: offer.contractor.name,
    respondedBy: offer.respondedBy,
    acceptance: offer.acceptance
      ? {
          ...acceptanceView(offer.acceptance),
          committedCostCents: money(offer.acceptance.committedCostCents),
          companyGstRegistered: offer.acceptance.companyGstRegistered,
        }
      : null,
  };
}

type OwnOffer = OfficeOffer & {
  job: Pick<Job, "reference" | "title" | "status" | "dueOn">;
};

/**
 * Contractor view: their own terms and the job's reference, title and status.
 * Positive allowlist: no job price, committed cost or company GST position.
 */
function ownOfferView(offer: OwnOffer) {
  return {
    ...termsView(offer),
    contractorActive: offer.contractor.archivedAt === null,
    job: {
      reference: offer.job.reference,
      title: offer.job.title,
      status: offer.job.status,
      dueOn: offer.job.dueOn
        ? offer.job.dueOn.toISOString().slice(0, 10)
        : null,
    },
    acceptance: offer.acceptance ? acceptanceView(offer.acceptance) : null,
  };
}

/** The login exists, is an active subcontractor here and isn't linked yet. */
async function linkProblem(
  db: PrismaClient,
  companyId: string,
  userId: string | null | undefined,
  contractorId?: string,
): Promise<string | null> {
  if (!userId) return null;
  const membership = await db.membership.findUnique({
    where: { companyId_userId: { companyId, userId } },
  });
  if (!membership?.isActive || membership.role !== "subcontractor")
    return "Choose a subcontractor login of this company";
  const taken = await db.contractor.findFirst({
    where: {
      companyId,
      userId,
      ...(contractorId ? { NOT: { id: contractorId } } : {}),
    },
    select: { id: true },
  });
  return taken ? LINKED : null;
}

const GST_NEEDS_ABN = "Enter the ABN of a GST-registered contractor";

async function ownContractor(db: PrismaClient, actor: Actor, id: string) {
  const safe = uuidOrNull(id);
  return requireSameCompany(
    actor,
    safe ? await db.contractor.findUnique({ where: { id: safe } }) : null,
  );
}

/** The contractor record linked to the signed-in subcontractor, or 404. */
async function linkedContractor(db: PrismaClient, actor: Actor) {
  const contractor = await db.contractor.findFirst({
    where: { companyId: actor.companyId, userId: actor.userId },
  });
  if (!contractor) throw notFound();
  return contractor;
}

/**
 * Lock order everywhere: contractor, then offer, then job. Contractor edits
 * (link, archive, GST registration) take the same contractor lock, so every
 * check below sees the contractor as it is when the write commits.
 */
async function lockedContractor(tx: Prisma.TransactionClient, id: string) {
  await lockRow(tx, "contractors", id);
  return tx.contractor.findUniqueOrThrow({ where: { id } });
}

async function lockedOffer(tx: Prisma.TransactionClient, id: string) {
  await lockRow(tx, "contractor_offers", id);
  return tx.contractorOffer.findUniqueOrThrow({
    where: { id },
    include: { contractor: true, acceptance: true },
  });
}

const OFFER_INCLUDE = { contractor: true, acceptance: true } as const;

export function contractorHandlers(db: () => PrismaClient) {
  const list: PolicyHandler<unknown> = async ({ actor, request }) => {
    const params = new URL(request.url).searchParams;
    const { page, take, skip } = parsePage(params);
    const status = STATUS.parse(params.get("status") ?? undefined);
    const q = params.get("q")?.trim().slice(0, 100);
    const filter: Prisma.ContractorWhereInput = {
      ...(status === "all"
        ? {}
        : { archivedAt: status === "active" ? null : { not: null } }),
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: "insensitive" } },
              { email: { contains: q, mode: "insensitive" } },
              { abn: { contains: q.replaceAll(" ", "") } },
            ],
          }
        : {}),
    };
    const where: Prisma.ContractorWhereInput = companyScope(actor, filter);
    const [rows, total] = await Promise.all([
      db().contractor.findMany({
        where,
        orderBy: [{ name: "asc" }, { id: "asc" }],
        take,
        skip,
      }),
      db().contractor.count({ where }),
    ]);
    return privateJson({
      page,
      pageSize: take,
      total,
      contractors: rows.map((row) =>
        visibleFields(actor, row, CONTRACTOR_FIELDS),
      ),
    });
  };

  /** One contractor with every offer made to them (newest first). */
  const read: PolicyHandler<IdContext> = async ({ actor, context }) => {
    const contractor = await ownContractor(
      db(),
      actor,
      (await context.params).id,
    );
    const offers = await db().contractorOffer.findMany({
      where: { companyId: actor.companyId, contractorId: contractor.id },
      include: OFFER_INCLUDE,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    });
    return privateJson({
      ...visibleFields(actor, contractor, CONTRACTOR_FIELDS),
      offers: offers.map(officeOfferView),
    });
  };

  const create: PolicyHandler<unknown> = async ({ actor, request }) => {
    const parsed = CreateContractor.safeParse(await jsonOrNull(request));
    if (!parsed.success) return invalid(parsed.error);
    const data = defined(parsed.data);
    if (data.gstRegistered && !data.abn) return fail(400, GST_NEEDS_ABN, "abn");
    const problem = await linkProblem(db(), actor.companyId, data.userId);
    if (problem) return fail(400, problem, "userId");
    try {
      const row = await withAudit(db(), async (tx, audit) => {
        const created = await tx.contractor.create({
          data: {
            ...data,
            companyId: actor.companyId,
            createdBy: actor.userId,
          },
        });
        await audit({
          companyId: actor.companyId,
          actorUserId: actor.userId,
          action: "contractor.created",
          target: { type: "contractor", id: created.id },
          after: {
            name: created.name,
            abn: created.abn,
            gstRegistered: created.gstRegistered,
            userId: created.userId,
          },
        });
        return created;
      });
      return privateJson(visibleFields(actor, row, CONTRACTOR_FIELDS), {
        status: 201,
      });
    } catch (error) {
      if (isUniqueViolation(error, "user_id"))
        return fail(400, LINKED, "userId");
      throw error;
    }
  };

  /**
   * Edit, link/unlink a login, archive or restore; never deleted. Locked and
   * re-read inside the audited transaction; a request that changes nothing
   * records nothing.
   */
  const update: PolicyHandler<IdContext> = async ({
    actor,
    request,
    context,
  }) => {
    const parsed = UpdateContractor.safeParse(await jsonOrNull(request));
    if (!parsed.success) return invalid(parsed.error);
    const owned = await ownContractor(db(), actor, (await context.params).id);
    const { archived, ...rest } = defined(parsed.data);
    const problem = await linkProblem(
      db(),
      actor.companyId,
      rest.userId,
      owned.id,
    );
    if (problem) return fail(400, problem, "userId");
    try {
      return await inTransaction(async () => {
        const row = await withAudit(db(), async (tx, audit) => {
          await lockRow(tx, "contractors", owned.id);
          const before = await tx.contractor.findUniqueOrThrow({
            where: { id: owned.id },
          });
          const next: Partial<Contractor> = {
            ...rest,
            ...(archived === undefined
              ? {}
              : {
                  archivedAt: archived
                    ? (before.archivedAt ?? new Date())
                    : null,
                }),
          };
          const abn = next.abn === undefined ? before.abn : next.abn;
          const registered = next.gstRegistered ?? before.gstRegistered;
          if (registered && !abn)
            throw new Refusal(fail(400, GST_NEEDS_ABN, "abn"));
          const changed = (Object.keys(next) as (keyof Contractor)[]).filter(
            (key) => !same(before[key], next[key]),
          );
          if (changed.length === 0)
            throw new Refusal(
              privateJson(visibleFields(actor, before, CONTRACTOR_FIELDS)),
            );
          const updated = await tx.contractor.update({
            where: { id: owned.id },
            data: Object.fromEntries(changed.map((key) => [key, next[key]])),
          });
          const pick = (record: Contractor) =>
            Object.fromEntries(changed.map((key) => [key, record[key]]));
          await audit({
            companyId: actor.companyId,
            actorUserId: actor.userId,
            action:
              changed.length === 1 && changed[0] === "archivedAt"
                ? `contractor.${updated.archivedAt ? "archived" : "restored"}`
                : "contractor.updated",
            target: { type: "contractor", id: owned.id },
            before: pick(before),
            after: pick(updated),
          });
          return updated;
        });
        return privateJson(visibleFields(actor, row, CONTRACTOR_FIELDS));
      });
    } catch (error) {
      if (isUniqueViolation(error, "user_id"))
        return fail(400, LINKED, "userId");
      throw error;
    }
  };

  /** Every offer on one job of this company, with contractor and acceptance. */
  const jobOffers: PolicyHandler<IdContext> = async ({ actor, context }) => {
    const safe = uuidOrNull((await context.params).id);
    const job = requireSameCompany(
      actor,
      safe ? await db().job.findUnique({ where: { id: safe } }) : null,
    );
    const offers = await db().contractorOffer.findMany({
      where: { companyId: actor.companyId, jobId: job.id },
      include: OFFER_INCLUDE,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    return privateJson({ offers: offers.map(officeOfferView) });
  };

  /** Offer work on an open job to an active contractor (audited). */
  const createOffer: PolicyHandler<IdContext> = async ({
    actor,
    request,
    context,
  }) => {
    const parsed = CreateOffer.safeParse(await jsonOrNull(request));
    if (!parsed.success) return invalid(parsed.error);
    const safe = uuidOrNull((await context.params).id);
    const owned = requireSameCompany(
      actor,
      safe ? await db().job.findUnique({ where: { id: safe } }) : null,
    );
    const { estimatedHours, ...data } = defined(parsed.data);
    const contractor = await db().contractor.findFirst({
      where: { id: data.contractorId, companyId: actor.companyId },
    });
    if (!contractor || contractor.archivedAt)
      return fail(400, "Choose an active contractor", "contractorId");
    const terms: Terms = {
      rateType: data.rateType,
      rateExclusiveCents: data.rateExclusiveCents,
      estimatedHoursHundredths: estimatedHours ?? null,
      taxCode: data.taxCode,
    };
    const result = priced(terms, contractor);
    if ("problem" in result)
      return fail(400, result.problem[1], result.problem[0]);
    try {
      return await inTransaction(async () => {
        const offer = await withAudit(db(), async (tx, audit) => {
          // Re-check the preflight under the contractor lock.
          const current = await lockedContractor(tx, contractor.id);
          if (current.archivedAt)
            throw new Refusal(
              fail(400, "Choose an active contractor", "contractorId"),
            );
          const recheck = priced(terms, current);
          if ("problem" in recheck)
            throw new Refusal(
              fail(400, recheck.problem[1], recheck.problem[0]),
            );
          const job = await lockedJob(tx, owned.id);
          if (!isJobEditable(job.status))
            throw new Refusal(
              fail(409, `A ${job.status} job can't get new offers`),
            );
          const created = await tx.contractorOffer.create({
            data: {
              ...terms,
              companyId: actor.companyId,
              jobId: job.id,
              contractorId: contractor.id,
              scope: data.scope,
              createdBy: actor.userId,
            },
            include: OFFER_INCLUDE,
          });
          await audit({
            companyId: actor.companyId,
            actorUserId: actor.userId,
            action: "contractor_offer.created",
            target: { type: "contractor_offer", id: created.id },
            after: { jobId: job.id, contractorId: contractor.id, ...terms },
          });
          return created;
        });
        return privateJson(officeOfferView(offer), { status: 201 });
      });
    } catch (error) {
      if (isUniqueViolation(error, "contractor_offers_live_key"))
        return fail(409, LIVE_OFFER, "contractorId");
      throw error;
    }
  };

  /**
   * Change an open offer's terms, or withdraw it. Accepted, declined and
   * withdrawn offers are final (409); the database refuses it too.
   */
  const updateOffer: PolicyHandler<OfferContext> = async ({
    actor,
    request,
    context,
  }) => {
    const parsed = UpdateOffer.safeParse(await jsonOrNull(request));
    if (!parsed.success) return invalid(parsed.error);
    const { id, offerId } = await context.params;
    const jobId = uuidOrNull(id);
    const safe = uuidOrNull(offerId);
    const owned = requireSameCompany(
      actor,
      jobId && safe
        ? await db().contractorOffer.findFirst({ where: { id: safe, jobId } })
        : null,
    );
    const { status, note, estimatedHours, ...rest } = defined(parsed.data);
    return inTransaction(async () => {
      const offer = await withAudit(db(), async (tx, audit) => {
        await lockedContractor(tx, owned.contractorId);
        const before = await lockedOffer(tx, owned.id);
        if (before.status !== "offered")
          throw new Refusal(
            fail(409, `An ${before.status} offer can't be changed`),
          );
        if (status === "withdrawn") {
          const updated = await tx.contractorOffer.update({
            where: { id: before.id },
            data: {
              status: "withdrawn",
              responseNote: note ?? null,
              respondedAt: new Date(),
              respondedBy: actor.userId,
            },
            include: OFFER_INCLUDE,
          });
          await audit({
            companyId: actor.companyId,
            actorUserId: actor.userId,
            action: "contractor_offer.withdrawn",
            target: { type: "contractor_offer", id: before.id },
            before: { status: before.status },
            after: { status: updated.status },
          });
          return updated;
        }
        const job = await lockedJob(tx, before.jobId);
        if (!isJobEditable(job.status))
          throw new Refusal(
            fail(409, `Offers on a ${job.status} job can't be changed`),
          );
        const next = {
          ...rest,
          ...(estimatedHours !== undefined
            ? { estimatedHoursHundredths: estimatedHours }
            : {}),
        };
        const merged = { ...before, ...next };
        const result = priced(merged, before.contractor);
        if ("problem" in result)
          throw new Refusal(fail(400, result.problem[1], result.problem[0]));
        const changed = (Object.keys(next) as (keyof typeof next)[]).filter(
          (key) => !same(before[key], next[key]),
        );
        if (changed.length === 0)
          throw new Refusal(privateJson(officeOfferView(before)));
        const updated = await tx.contractorOffer.update({
          where: { id: before.id },
          data: Object.fromEntries(changed.map((key) => [key, next[key]])),
          include: OFFER_INCLUDE,
        });
        await audit({
          companyId: actor.companyId,
          actorUserId: actor.userId,
          action: "contractor_offer.updated",
          target: { type: "contractor_offer", id: before.id },
          before: Object.fromEntries(changed.map((key) => [key, before[key]])),
          after: Object.fromEntries(changed.map((key) => [key, updated[key]])),
        });
        return updated;
      });
      return privateJson(officeOfferView(offer));
    });
  };

  /** The signed-in subcontractor's own offers (newest first). */
  const myOffers: PolicyHandler<unknown> = async ({ actor, request }) => {
    if (actor.role !== "subcontractor") throw notFound();
    const params = new URL(request.url).searchParams;
    const contractor = await db().contractor.findFirst({
      where: { companyId: actor.companyId, userId: actor.userId },
    });
    const { page, take, skip } = parsePage(params);
    const jobsOnly = params.get("view") === "jobs";
    const status = z
      .enum(["offered", "accepted", "declined", "withdrawn"])
      .optional()
      .catch(undefined)
      .parse(params.get("status") || undefined);
    const q = params.get("q")?.trim().slice(0, 100);
    if (!contractor || (jobsOnly && contractor.archivedAt))
      return privateJson({ page, pageSize: take, total: 0, offers: [] });
    const where: Prisma.ContractorOfferWhereInput = {
      companyId: actor.companyId,
      contractorId: contractor.id,
      ...(jobsOnly ? { status: "accepted" } : status ? { status } : {}),
      ...(q
        ? {
            OR: [
              { scope: { contains: q, mode: "insensitive" } },
              { job: { title: { contains: q, mode: "insensitive" } } },
              { job: { reference: { contains: q, mode: "insensitive" } } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      db().contractorOffer.findMany({
        where,
        include: {
          ...OFFER_INCLUDE,
          job: {
            select: { reference: true, title: true, status: true, dueOn: true },
          },
        },
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        take,
        skip,
      }),
      db().contractorOffer.count({ where }),
    ]);
    return privateJson({
      page,
      pageSize: take,
      total,
      offers: rows.map(ownOfferView),
    });
  };

  /** One own offer, using the same positive projection as the list. */
  const myOffer: PolicyHandler<IdContext> = async ({ actor, context }) => {
    if (actor.role !== "subcontractor") throw notFound();
    const id = uuidOrNull((await context.params).id);
    const offer = id
      ? await db().contractorOffer.findFirst({
          where: {
            id,
            companyId: actor.companyId,
            contractor: { companyId: actor.companyId, userId: actor.userId },
          },
          include: {
            ...OFFER_INCLUDE,
            job: {
              select: {
                reference: true,
                title: true,
                status: true,
                dueOn: true,
              },
            },
          },
        })
      : null;
    if (!offer) throw notFound();
    return privateJson(ownOfferView(offer));
  };

  /**
   * Accept or decline an open offer made to the caller's own contractor
   * record. Acceptance snapshots the terms, their GST and the committed job
   * cost exactly once (unique per offer, append-only), under the offer lock.
   * Another contractor's offer is "not found".
   */
  const respond: PolicyHandler<IdContext> = async ({
    actor,
    request,
    context,
  }) => {
    const parsed = Respond.safeParse(await jsonOrNull(request));
    if (!parsed.success) return invalid(parsed.error);
    const contractor = await linkedContractor(db(), actor);
    const safe = uuidOrNull((await context.params).id);
    const owned = requireSameCompany(
      actor,
      safe
        ? await db().contractorOffer.findFirst({
            where: { id: safe, contractorId: contractor.id },
          })
        : null,
    );
    const { decision, note } = parsed.data;
    return inTransaction(async () => {
      const offer = await withAudit(db(), async (tx, audit) => {
        // The office may have unlinked or relinked this contractor since the
        // preflight: answer only if the caller is still its login.
        const current = await lockedContractor(tx, contractor.id);
        if (current.userId !== actor.userId) throw notFound();
        const before = await lockedOffer(tx, owned.id);
        if (before.status !== "offered")
          throw new Refusal(
            fail(409, `This offer is already ${before.status}`),
          );
        if (before.contractor.archivedAt)
          throw new Refusal(
            fail(
              409,
              "Your contractor record is archived. Contact the office.",
            ),
          );
        const job = await lockedJob(tx, before.jobId);
        if (!isJobEditable(job.status))
          throw new Refusal(fail(409, `The job is ${job.status}`));
        const respondedAt = new Date();
        const closed = {
          responseNote: note ?? null,
          respondedAt,
          respondedBy: actor.userId,
        };
        if (decision === "decline") {
          await tx.contractorOffer.update({
            where: { id: before.id },
            data: { status: "declined", ...closed },
          });
          await audit({
            companyId: actor.companyId,
            actorUserId: actor.userId,
            action: "contractor_offer.declined",
            target: { type: "contractor_offer", id: before.id },
            before: { status: before.status },
            after: { status: "declined" },
          });
        } else {
          const result = priced(before, before.contractor);
          if ("problem" in result)
            throw new Refusal(
              fail(
                409,
                "These terms no longer match your GST registration. Ask the office to update the offer.",
              ),
            );
          const { line } = result;
          const company = await companyGstStatusOn(
            tx,
            actor.companyId,
            sydneyToday(respondedAt),
          );
          const committedCostCents = committedJobCost(line, company.registered);
          await tx.contractorOffer.update({
            where: { id: before.id },
            data: { status: "accepted", ...closed },
          });
          await tx.contractorAcceptance.create({
            data: {
              companyId: actor.companyId,
              offerId: before.id,
              jobId: before.jobId,
              contractorId: before.contractorId,
              rateType: before.rateType,
              rateExclusiveCents: before.rateExclusiveCents,
              estimatedHoursHundredths: before.estimatedHoursHundredths,
              taxCode: before.taxCode,
              gstRateBasisPoints: Number(line.rateBasisPoints),
              exclusiveCents: line.exclusive,
              gstCents: line.gst,
              inclusiveCents: line.inclusive,
              contractorGstRegistered: before.contractor.gstRegistered,
              companyGstRegistered: company.registered,
              committedCostCents,
              acceptedAt: respondedAt,
              acceptedBy: actor.userId,
            },
          });
          await audit({
            companyId: actor.companyId,
            actorUserId: actor.userId,
            action: "contractor_offer.accepted",
            target: { type: "contractor_offer", id: before.id },
            before: { status: before.status },
            after: {
              status: "accepted",
              exclusiveCents: line.exclusive,
              gstCents: line.gst,
              committedCostCents,
            },
          });
        }
        return tx.contractorOffer.findUniqueOrThrow({
          where: { id: before.id },
          include: {
            ...OFFER_INCLUDE,
            job: {
              select: {
                reference: true,
                title: true,
                status: true,
                dueOn: true,
              },
            },
          },
        });
      });
      return privateJson(ownOfferView(offer));
    });
  };

  return {
    list,
    read,
    create,
    update,
    jobOffers,
    createOffer,
    updateOffer,
    myOffers,
    myOffer,
    respond,
  };
}

/** Value equality for Prisma scalars (Dates, bigints, strings, null). */
function same(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date)
    return a.getTime() === b.getTime();
  return a === b;
}
