import {
  type FieldRules,
  requireOwnCompany,
  visibleFields,
} from "@jobflow/authz";
import { z } from "zod";
import type {
  Company,
  PrismaClient,
} from "../../../../../packages/database/src/generated/prisma/client";
import { withAudit } from "../../../../../packages/database/src/index";
import { type PolicyHandler, privateJson } from "../authz/policy";
import { HttpError, readJson } from "../http/guards";

/** Positive allowlist of company fields returned to clients. */
const COMPANY_FIELDS: FieldRules<Company> = {
  id: true,
  name: true,
  isDemo: true,
};

/** Unknown keys (including a forged `companyId`) are stripped, never trusted. */
const RenameCompany = z.object({ name: z.string().trim().min(1).max(200) });

export function companyHandlers(db: () => PrismaClient) {
  const read: PolicyHandler<unknown> = async ({ actor }) => {
    const company = requireOwnCompany(
      actor,
      await db().company.findUnique({ where: { id: actor.companyId } }),
    );
    return privateJson(visibleFields(actor, company, COMPANY_FIELDS));
  };

  const rename: PolicyHandler<unknown> = async ({ actor, request }) => {
    const parsed = RenameCompany.safeParse(
      await readJson(request).catch((error: unknown) => {
        // Oversized or non-JSON bodies keep their own status (413/415).
        if (error instanceof HttpError && error.status !== 400) throw error;
        return null;
      }),
    );
    if (!parsed.success) {
      return privateJson(
        { error: "Enter a company name of 1–200 characters" },
        { status: 400 },
      );
    }
    const company = await withAudit(db(), async (tx, audit) => {
      const before = requireOwnCompany(
        actor,
        await tx.company.findUnique({ where: { id: actor.companyId } }),
      );
      const updated = await tx.company.update({
        where: { id: before.id },
        data: { name: parsed.data.name },
      });
      const requestId = request.headers.get("x-request-id");
      await audit({
        ...(requestId ? { requestId } : {}),
        companyId: actor.companyId,
        actorUserId: actor.userId,
        action: "company.renamed",
        target: { type: "company", id: before.id },
        before: { name: before.name },
        after: { name: updated.name },
      });
      return updated;
    });
    return privateJson(visibleFields(actor, company, COMPANY_FIELDS));
  };

  return { read, rename };
}
