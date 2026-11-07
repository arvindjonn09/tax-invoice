import { type Actor, can, requireOwnCompany } from "@jobflow/authz";
import type { PrismaClient } from "../../../../../packages/database/src/generated/prisma/client";
import { withAudit } from "../../../../../packages/database/src/index";
import type { CompanyAccess } from "../auth/actor";
import { type PolicyHandler, privateJson } from "../authz/policy";

/** One "Finish setting up your company" item (S5 AC8, design §10). */
export type SetupItem = {
  id: "business_details";
  label: string;
  done: boolean;
  href: string;
};

type ChecklistCompany = {
  addressLine1: string | null;
  suburb: string | null;
  state: string | null;
  postcode: string | null;
  setupChecklistDismissedAt: Date | null;
};

/**
 * The checklist items for a company. Only details an owner can already add
 * in Settings are listed; #228 adds contact details, logo and about.
 */
export function setupItems(company: ChecklistCompany): SetupItem[] {
  return [
    {
      id: "business_details",
      label: "Business address",
      done: Boolean(
        company.addressLine1 &&
        company.suburb &&
        company.state &&
        company.postcode,
      ),
      href: "/settings",
    },
  ];
}

/**
 * The checklist to show, or null: owners only, never while read-only, and
 * gone once dismissed or every item is done.
 */
export function visibleSetupChecklist(
  actor: Pick<Actor, "role">,
  access: Pick<CompanyAccess, "readOnly">,
  company: ChecklistCompany,
): SetupItem[] | null {
  if (!can(actor.role, "company.update") || access.readOnly) return null;
  if (company.setupChecklistDismissedAt) return null;
  const items = setupItems(company);
  return items.every((item) => item.done) ? null : items;
}

/** Load the checklist for the actor's company (server components). */
export async function setupChecklistFor(
  db: PrismaClient,
  actor: Actor,
  access: Pick<CompanyAccess, "readOnly">,
): Promise<SetupItem[] | null> {
  if (!can(actor.role, "company.update") || access.readOnly) return null;
  const company = await db.company.findUniqueOrThrow({
    where: { id: actor.companyId },
    select: {
      addressLine1: true,
      suburb: true,
      state: true,
      postcode: true,
      setupChecklistDismissedAt: true,
    },
  });
  return visibleSetupChecklist(actor, access, company);
}

/** Another request dismissed it first; nothing to write or audit. */
class AlreadyDismissed extends Error {}

/** POST /api/company/setup-checklist/dismiss (company.update; audited once). */
export function setupChecklistHandlers(db: () => PrismaClient) {
  const current = async (companyId: string) =>
    (
      await db().company.findUniqueOrThrow({
        where: { id: companyId },
        select: { setupChecklistDismissedAt: true },
      })
    ).setupChecklistDismissedAt;

  const dismiss: PolicyHandler<unknown> = async ({ actor, request }) => {
    // Dismissing twice (or in two tabs at once) changes nothing and records
    // nothing new: only the write that sets it is audited.
    const already = requireOwnCompany(
      actor,
      await db().company.findUnique({
        where: { id: actor.companyId },
        select: { id: true, setupChecklistDismissedAt: true },
      }),
    ).setupChecklistDismissedAt;
    if (already) return privateJson({ dismissedAt: already.toISOString() });
    const dismissed = new Date();
    try {
      await withAudit(db(), async (tx, audit) => {
        const { count } = await tx.company.updateMany({
          where: { id: actor.companyId, setupChecklistDismissedAt: null },
          data: { setupChecklistDismissedAt: dismissed },
        });
        if (count === 0) throw new AlreadyDismissed();
        const requestId = request.headers.get("x-request-id");
        await audit({
          ...(requestId ? { requestId } : {}),
          companyId: actor.companyId,
          actorUserId: actor.userId,
          action: "company.setup_checklist_dismissed",
          target: { type: "company", id: actor.companyId },
        });
      });
    } catch (error) {
      if (!(error instanceof AlreadyDismissed)) throw error;
      const raced = await current(actor.companyId);
      return privateJson({ dismissedAt: raced?.toISOString() ?? null });
    }
    return privateJson({ dismissedAt: dismissed.toISOString() });
  };
  return { dismiss };
}
