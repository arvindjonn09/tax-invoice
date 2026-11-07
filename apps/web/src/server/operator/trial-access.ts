import { addDays, sydneyDate, validateDirectExtension } from "@jobflow/domain";
import type {
  Prisma,
  PrismaClient,
} from "../../../../../packages/database/src/generated/prisma/client";
import { withAudit } from "../../../../../packages/database/src/index";
import { enqueueEmail } from "../email/outbox";

/** A clear refusal that changes nothing (S11 AC4, AC8). */
export class TrialAccessError extends Error {
  constructor(
    readonly code:
      | "unknown_company"
      | "demo_company"
      | "not_on_trial"
      | "already_in_mode"
      | "invalid_date"
      | "invalid_reason",
    message: string,
  ) {
    super(message);
  }
}

export type TrialAccessDependencies = {
  db: PrismaClient;
  emailSecret: string;
  appUrl: string;
  now?: () => Date;
};

type Base = {
  operatorUserId: string;
  companyId: string;
  reason: string;
  requestId?: string;
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const asDate = (day: string) => new Date(`${day}T00:00:00Z`);
const asDay = (date: Date) => date.toISOString().slice(0, 10);

function checkedReason(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed.length < 1 || trimmed.length > 500) {
    throw new TrialAccessError(
      "invalid_reason",
      "Enter a reason of 1–500 characters",
    );
  }
  return trimmed;
}

function checkedDay(day: string): string {
  // A real calendar day: 2026-02-30 doesn't survive the round trip.
  if (
    !DAY.test(day) ||
    Number.isNaN(asDate(day).getTime()) ||
    asDay(asDate(day)) !== day
  ) {
    throw new TrialAccessError("invalid_date", "Enter a valid date");
  }
  return day;
}

const REFUSALS = {
  not_later: "The new last day must be later than the current one",
  before_today: "The new last day can't be in the past",
  too_far: "The new last day can be at most 365 days from today",
} as const;

/** Serialises every change to one company; the row stays locked until commit. */
async function lockCompany(tx: Prisma.TransactionClient, companyId: string) {
  const [company] = await tx.$queryRaw<
    {
      id: string;
      is_demo: boolean;
      access_mode: "trial" | "unrestricted";
      trial_last_day: Date | null;
      trial_started_at: Date | null;
    }[]
  >`SELECT id, is_demo, access_mode, trial_last_day, trial_started_at
    FROM companies WHERE id = ${companyId}::uuid FOR UPDATE`;
  if (!company) {
    throw new TrialAccessError("unknown_company", "No company has that ID");
  }
  if (company.is_demo) {
    throw new TrialAccessError(
      "demo_company",
      "Demo companies don't have a trial",
    );
  }
  return company;
}

/** Fixed wording only, as for other account email (S2 AC9). */
async function emailOwners(
  tx: Prisma.TransactionClient,
  deps: TrialAccessDependencies,
  companyId: string,
  kind: "trial_extended" | "access_changed",
  key: string,
  subject: string,
  lines: readonly string[],
) {
  const owners = await tx.membership.findMany({
    where: { companyId, role: "owner", isActive: true },
    select: { userId: true, user: { select: { email: true } } },
  });
  for (const owner of owners) {
    await enqueueEmail(tx, deps.emailSecret, {
      kind,
      dedupeKey: `${kind}:${companyId}:${key}:${owner.userId}`,
      userId: owner.userId,
      companyId,
      message: {
        to: owner.user.email,
        subject,
        text: [...lines, "", `Sign in: ${deps.appUrl}/login`].join("\n"),
      },
    });
  }
}

/** Closes a pending request, because any extension settles it (S14 AC8). */
async function closePending(
  tx: Prisma.TransactionClient,
  input: Base,
  now: Date,
  closedReason: "direct_extension" | "made_unrestricted",
  newLastDay: string | null,
) {
  await tx.trialExtensionRequest.updateMany({
    where: { companyId: input.companyId, status: "pending" },
    data: {
      status: "closed",
      decidedAt: now,
      decidedBy: input.operatorUserId,
      closedReason,
      newLastDay: newLastDay ? asDate(newLastDay) : null,
    },
  });
}

/** S11 AC3–AC5, AC7: a direct extension, effective on commit. */
export async function extendTrial(
  deps: TrialAccessDependencies,
  input: Base & { lastDay: string },
): Promise<{ lastDay: string }> {
  const reason = checkedReason(input.reason);
  const lastDay = checkedDay(input.lastDay);
  const now = deps.now?.() ?? new Date();
  await withAudit(
    deps.db,
    async (tx, audit) => {
      const company = await lockCompany(tx, input.companyId);
      if (company.access_mode !== "trial" || !company.trial_last_day) {
        throw new TrialAccessError(
          "not_on_trial",
          "This company isn't on a trial",
        );
      }
      const current = asDay(company.trial_last_day);
      const check = validateDirectExtension(current, lastDay, sydneyDate(now));
      if (!check.ok) {
        throw new TrialAccessError("invalid_date", REFUSALS[check.reason]);
      }
      await tx.company.update({
        where: { id: input.companyId },
        data: {
          trialLastDay: asDate(lastDay),
          trialExtensionCount: { increment: 1 },
        },
      });
      await closePending(tx, input, now, "direct_extension", lastDay);
      await audit({
        companyId: input.companyId,
        actor: { kind: "operator", operatorUserId: input.operatorUserId },
        action: "trial.extended",
        target: { type: "company", id: input.companyId },
        ...(input.requestId ? { requestId: input.requestId } : {}),
        before: { trialLastDay: current, reason: null },
        after: { trialLastDay: lastDay, reason },
      });
      await emailOwners(
        tx,
        deps,
        input.companyId,
        "trial_extended",
        lastDay,
        "Your JobFlow trial was extended",
        [
          `Your JobFlow trial now runs until ${lastDay}.`,
          "Your company can keep adding and changing records until then.",
        ],
      );
    },
    { readOnlyExemption: "operator" },
  );
  return { lastDay };
}

/** S13 AC3: switch between trial and unrestricted. */
export async function setAccessMode(
  deps: TrialAccessDependencies,
  input: Base &
    (
      | { mode: "unrestricted"; lastDay?: undefined }
      | { mode: "trial"; lastDay: string }
    ),
): Promise<void> {
  const reason = checkedReason(input.reason);
  const lastDay = input.mode === "trial" ? checkedDay(input.lastDay) : null;
  const now = deps.now?.() ?? new Date();
  await withAudit(
    deps.db,
    async (tx, audit) => {
      const company = await lockCompany(tx, input.companyId);
      if (company.access_mode === input.mode) {
        throw new TrialAccessError(
          "already_in_mode",
          `This company is already ${input.mode}`,
        );
      }
      if (lastDay) {
        const today = sydneyDate(now);
        if (lastDay < today || lastDay > addDays(today, 365)) {
          throw new TrialAccessError(
            "invalid_date",
            "The last day must be between today and 365 days from today",
          );
        }
      }
      await tx.company.update({
        where: { id: input.companyId },
        data: lastDay
          ? {
              accessMode: "trial",
              trialLastDay: asDate(lastDay),
              trialStartedAt: company.trial_started_at ?? now,
            }
          : { accessMode: "unrestricted" },
      });
      if (input.mode === "unrestricted") {
        await closePending(tx, input, now, "made_unrestricted", null);
      }
      await audit({
        companyId: input.companyId,
        actor: { kind: "operator", operatorUserId: input.operatorUserId },
        action: "company.access_mode_changed",
        target: { type: "company", id: input.companyId },
        ...(input.requestId ? { requestId: input.requestId } : {}),
        before: {
          mode: company.access_mode,
          trialLastDay: company.trial_last_day
            ? asDay(company.trial_last_day)
            : null,
          reason: null,
        },
        after: {
          mode: input.mode,
          trialLastDay: lastDay,
          reason,
        },
      });
      await emailOwners(
        tx,
        deps,
        input.companyId,
        "access_changed",
        `${input.mode}:${now.getTime()}`,
        "Your JobFlow access changed",
        [
          lastDay
            ? `Your company is now on a JobFlow trial until ${lastDay}.`
            : "Your company's JobFlow access no longer has a trial end date.",
        ],
      );
    },
    { readOnlyExemption: "operator" },
  );
}
