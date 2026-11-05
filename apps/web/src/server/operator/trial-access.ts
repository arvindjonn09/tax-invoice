import {
  addDays,
  extensionLastDay,
  sydneyDate,
  validateDirectExtension,
} from "@jobflow/domain";
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
      | "invalid_reason"
      | "invalid_days"
      | "unknown_request"
      | "already_decided",
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

/**
 * The outcome goes to every active owner with a verified email (S14 AC9), by
 * email and as a notice shown until it's dismissed. Only the decline reason is
 * operator-written; nothing here comes from a company member.
 */
async function tellOwners(
  tx: Prisma.TransactionClient,
  deps: TrialAccessDependencies,
  companyId: string,
  kind: "trial_extended" | "access_changed" | "trial_extension_declined",
  key: string,
  subject: string,
  lines: readonly string[],
  noticeKey?: string,
) {
  const owners = await tx.membership.findMany({
    where: {
      companyId,
      role: "owner",
      isActive: true,
      user: { emailVerified: true },
    },
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
  if (noticeKey) {
    await tx.userNotice.createMany({
      data: owners.map((owner) => ({
        userId: owner.userId,
        companyId,
        noticeKey,
      })),
      skipDuplicates: true,
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
      await tellOwners(
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
        `trial.extended:${lastDay}`,
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
      await tellOwners(
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

/** Finds the request, then locks its company and re-reads it (S14 AC7). */
async function lockPendingRequest(
  tx: Prisma.TransactionClient,
  requestId: string,
) {
  const found = await tx.trialExtensionRequest.findUnique({
    where: { id: requestId },
    select: { companyId: true },
  });
  if (!found) {
    throw new TrialAccessError("unknown_request", "No request has that ID");
  }
  const company = await lockCompany(tx, found.companyId);
  const request = await tx.trialExtensionRequest.findUniqueOrThrow({
    where: { id: requestId },
  });
  if (request.status !== "pending") {
    throw new TrialAccessError(
      "already_decided",
      "This request has already been decided",
    );
  }
  return { company, request };
}

/** S14 AC7: later of the current last day and yesterday, plus the days. */
export async function approveExtensionRequest(
  deps: TrialAccessDependencies,
  input: {
    operatorUserId: string;
    requestId: string;
    days: number;
    note?: string | undefined;
    auditRequestId?: string | undefined;
  },
): Promise<{ lastDay: string }> {
  if (!Number.isInteger(input.days) || input.days < 1 || input.days > 365) {
    throw new TrialAccessError("invalid_days", "Choose 1–365 days");
  }
  const note = input.note?.trim() || null;
  if (note && note.length > 500) {
    throw new TrialAccessError(
      "invalid_reason",
      "Use 500 characters or fewer for the note",
    );
  }
  const now = deps.now?.() ?? new Date();
  return withAudit(
    deps.db,
    async (tx, audit) => {
      const { company, request } = await lockPendingRequest(
        tx,
        input.requestId,
      );
      if (company.access_mode !== "trial" || !company.trial_last_day) {
        throw new TrialAccessError(
          "not_on_trial",
          "This company isn't on a trial",
        );
      }
      const current = asDay(company.trial_last_day);
      const lastDay = extensionLastDay(current, sydneyDate(now), input.days);
      await tx.company.update({
        where: { id: company.id },
        data: {
          trialLastDay: asDate(lastDay),
          trialExtensionCount: { increment: 1 },
        },
      });
      await tx.trialExtensionRequest.update({
        where: { id: request.id },
        data: {
          status: "approved",
          decidedAt: now,
          decidedBy: input.operatorUserId,
          extensionDays: input.days,
          decisionNote: note,
          newLastDay: asDate(lastDay),
        },
      });
      await audit({
        companyId: company.id,
        actor: { kind: "operator", operatorUserId: input.operatorUserId },
        action: "trial_extension.approved",
        target: { type: "trial_extension_request", id: request.id },
        ...(input.auditRequestId ? { requestId: input.auditRequestId } : {}),
        before: { trialLastDay: current, status: "pending", note: null },
        after: { trialLastDay: lastDay, status: "approved", note },
      });
      await tellOwners(
        tx,
        deps,
        company.id,
        "trial_extended",
        lastDay,
        "Your JobFlow trial was extended",
        [
          `Your request was approved. Your JobFlow trial now runs until ${lastDay}.`,
          "Your company can keep adding and changing records until then.",
        ],
        `trial.extended:${request.id}`,
      );
      return { lastDay };
    },
    { readOnlyExemption: "operator" },
  );
}

/** S14 AC7: a reason is required, and the trial is unchanged. */
export async function declineExtensionRequest(
  deps: TrialAccessDependencies,
  input: {
    operatorUserId: string;
    requestId: string;
    reason: string;
    auditRequestId?: string | undefined;
  },
): Promise<void> {
  const reason = checkedReason(input.reason);
  const now = deps.now?.() ?? new Date();
  await withAudit(
    deps.db,
    async (tx, audit) => {
      const { company, request } = await lockPendingRequest(
        tx,
        input.requestId,
      );
      await tx.trialExtensionRequest.update({
        where: { id: request.id },
        data: {
          status: "declined",
          decidedAt: now,
          decidedBy: input.operatorUserId,
          decisionNote: reason,
        },
      });
      await audit({
        companyId: company.id,
        actor: { kind: "operator", operatorUserId: input.operatorUserId },
        action: "trial_extension.declined",
        target: { type: "trial_extension_request", id: request.id },
        ...(input.auditRequestId ? { requestId: input.auditRequestId } : {}),
        before: { status: "pending", reason: null },
        after: { status: "declined", reason },
      });
      await tellOwners(
        tx,
        deps,
        company.id,
        "trial_extension_declined",
        request.id,
        "Your JobFlow trial extension request",
        [
          "Your request for more trial time was declined.",
          "",
          `Reason: ${reason}`,
        ],
        `trial.declined:${request.id}`,
      );
    },
    { readOnlyExemption: "operator" },
  );
}
