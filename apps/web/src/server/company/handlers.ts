import {
  type FieldRules,
  requireOwnCompany,
  visibleFields,
} from "@jobflow/authz";
import { isValidAbn, normaliseAbn } from "@jobflow/domain";
import { z } from "zod";
import type {
  Company,
  Prisma,
  PrismaClient,
} from "../../../../../packages/database/src/generated/prisma/client";
import { withAudit } from "../../../../../packages/database/src/index";
import { type PolicyHandler, privateJson } from "../authz/policy";
import { HttpError, readJson } from "../http/guards";

/**
 * Positive allowlist of company fields returned to clients. Every member sees
 * the name; legal, tax and numbering details are for those who manage GST
 * settings (owner, accountant).
 */
const COMPANY_FIELDS: FieldRules<Company> = {
  id: true,
  name: true,
  isDemo: true,
  legalName: "gst_settings.read",
  abn: "gst_settings.read",
  addressLine1: "gst_settings.read",
  addressLine2: "gst_settings.read",
  suburb: "gst_settings.read",
  state: "gst_settings.read",
  postcode: "gst_settings.read",
  invoicePrefix: "gst_settings.read",
  jobPrefix: "gst_settings.read",
  basPeriod: "gst_settings.read",
  // Pre-fills every expense form (#40), so every member may read it.
  defaultExpenseSettlement: true,
};

export const AUSTRALIAN_STATES = [
  "ACT",
  "NSW",
  "NT",
  "QLD",
  "SA",
  "TAS",
  "VIC",
  "WA",
] as const;

/** Trimmed text; an empty string clears the field. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((value) => (value ? value : null));

const prefix = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9-]{1,10}$/, "Use 1–10 letters, digits or hyphens");

/**
 * Partial profile update. Unknown keys (including a forged `companyId`) are
 * stripped, never trusted. An ABN must pass the ATO checksum and is stored as
 * 11 digits.
 */
export const UpdateCompany = z
  .object({
    name: z.string().trim().min(1).max(200),
    legalName: optionalText(200),
    abn: z
      .string()
      .nullable()
      .transform((value, context) => {
        if (value === null || value.trim() === "") return null;
        const digits = normaliseAbn(value);
        if (!digits || !isValidAbn(digits)) {
          context.addIssue({
            code: "custom",
            message: "Enter a valid 11-digit ABN",
          });
          return z.NEVER;
        }
        return digits;
      }),
    addressLine1: optionalText(200),
    addressLine2: optionalText(200),
    suburb: optionalText(100),
    state: z.enum(AUSTRALIAN_STATES).nullable(),
    postcode: z
      .string()
      .trim()
      .regex(/^\d{4}$/, "Enter a 4-digit postcode")
      .nullable(),
    invoicePrefix: prefix,
    jobPrefix: prefix,
    defaultExpenseSettlement: z.enum(["paid_at_purchase", "on_account"]),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, "Nothing to update");

/** 400 with a message per field (paths joined with "."). */
export function invalid(error: z.ZodError): Response {
  return privateJson(
    {
      error: "Check the highlighted fields",
      fields: Object.fromEntries(
        error.issues.map((issue) => [
          issue.path.join(".") || "_",
          issue.message,
        ]),
      ),
    },
    { status: 400 },
  );
}

/** Parse a JSON body; malformed bodies become null (→ 400 from the schema). */
export async function jsonOrNull(request: Request): Promise<unknown> {
  return readJson(request).catch((error: unknown) => {
    // Oversized or non-JSON bodies keep their own status (413/415).
    if (error instanceof HttpError && error.status !== 400) throw error;
    return null;
  });
}

export function companyHandlers(db: () => PrismaClient) {
  const read: PolicyHandler<unknown> = async ({ actor }) => {
    const company = requireOwnCompany(
      actor,
      await db().company.findUnique({ where: { id: actor.companyId } }),
    );
    return privateJson(visibleFields(actor, company, COMPANY_FIELDS));
  };

  /** Owners only (company.update); every change is audited field by field. */
  const update: PolicyHandler<unknown> = async ({ actor, request }) => {
    const parsed = UpdateCompany.safeParse(await jsonOrNull(request));
    if (!parsed.success) return invalid(parsed.error);
    // Drop absent keys (exactOptionalPropertyTypes): only sent fields change.
    const data = Object.fromEntries(
      Object.entries(parsed.data).filter(([, value]) => value !== undefined),
    ) as Prisma.CompanyUpdateInput;
    const fields = Object.keys(data) as (keyof Company)[];
    const company = await withAudit(db(), async (tx, audit) => {
      const before = requireOwnCompany(
        actor,
        await tx.company.findUnique({ where: { id: actor.companyId } }),
      );
      const updated = await tx.company.update({
        where: { id: before.id },
        data,
      });
      const pick = (record: Company) =>
        Object.fromEntries(fields.map((field) => [field, record[field]]));
      const requestId = request.headers.get("x-request-id");
      await audit({
        ...(requestId ? { requestId } : {}),
        companyId: actor.companyId,
        actorUserId: actor.userId,
        action:
          fields.length === 1 && fields[0] === "name"
            ? "company.renamed"
            : "company.profile_updated",
        target: { type: "company", id: before.id },
        before: pick(before),
        after: pick(updated),
      });
      return updated;
    });
    return privateJson(visibleFields(actor, company, COMPANY_FIELDS));
  };

  return { read, update };
}
