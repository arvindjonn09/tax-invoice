import {
  addDays,
  sydneyDate,
  TRIAL_THRESHOLDS,
  type TrialThreshold,
  trialStatus,
  trialThreshold,
} from "@jobflow/domain";
import type { PrismaClient } from "../../../../../packages/database/src/generated/prisma/client";
import { DEFAULT_SUPPORT_EMAIL } from "../email/addresses";
import { enqueueEmail } from "../email/outbox";
import type { EmailMessage } from "../email/transport";
import { log, safeError } from "../log";

// #233 (S10). The unique row on (company, last day, threshold) is what stops
// duplicates, across retries and hosts. Because the last day is part of it, an
// extension re-arms every threshold. Nothing here is audited: a reminder
// changes no record, so it also runs for read-only companies.

export type ReminderDeps = {
  db: PrismaClient;
  emailSecret: string;
  appUrl: string;
  supportEmail?: string;
  now?: () => Date;
};
export type ReminderResult = { sent: number; failed: number };

const rank = (threshold: TrialThreshold) => TRIAL_THRESHOLDS.indexOf(threshold);

/** "1 Dec 2026" for an ISO date. It's a calendar day, so UTC can't shift it. */
export function formatTrialDay(day: string): string {
  return new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${day}T00:00:00Z`));
}

export function reminderEmail(
  to: string,
  threshold: TrialThreshold,
  lastDay: string,
  appUrl: string,
  support: string,
): EmailMessage {
  const day = formatTrialDay(lastDay);
  const readOnly =
    "read-only: you can still view and export your records, but you can't add or change anything";
  const opening: Record<TrialThreshold, readonly [string, string]> = {
    d7: [
      `Your JobFlow trial ends on ${day}`,
      `Your JobFlow trial ends on ${day} (Sydney time). After that, your company becomes ${readOnly}.`,
    ],
    d3: [
      `Your JobFlow trial ends on ${day}`,
      `Your JobFlow trial ends soon, on ${day} (Sydney time). After that, your company becomes ${readOnly}.`,
    ],
    d1: [
      "Today is the last day of your JobFlow trial",
      `Today, ${day}, is the last day of your JobFlow trial. From 12:00 am tomorrow (Sydney time), your company becomes ${readOnly}.`,
    ],
    ended: [
      "Your JobFlow trial has ended",
      `Your JobFlow trial ended on ${day} (Sydney time). Your company is now ${readOnly}.`,
    ],
  };
  const [subject, first] = opening[threshold];
  return {
    to,
    subject,
    text: [
      first,
      "",
      "To keep working, request an extension:",
      `${appUrl}/settings/trial`,
      "",
      `Or email ${support}.`,
    ].join("\n"),
  };
}

/** Sends one company's reminder, if one is due. True when it sent. */
async function remindCompany(
  deps: ReminderDeps,
  companyId: string,
  now: Date,
): Promise<boolean> {
  return deps.db.$transaction(async (tx) => {
    // Locked, so an extension or a second host can't change the answer midway.
    const [company] = await tx.$queryRaw<
      {
        is_demo: boolean;
        access_mode: string;
        trial_last_day: Date | null;
      }[]
    >`SELECT is_demo, access_mode, trial_last_day FROM companies
      WHERE id = ${companyId}::uuid FOR UPDATE`;
    if (
      !company?.trial_last_day ||
      company.is_demo ||
      company.access_mode !== "trial"
    )
      return false;
    const lastDay = company.trial_last_day.toISOString().slice(0, 10);
    const threshold = trialThreshold(trialStatus(lastDay, now).daysRemaining);
    if (!threshold) return false;
    const sent = await tx.trialNotification.findMany({
      where: { companyId, trialLastDay: company.trial_last_day },
      select: { threshold: true },
    });
    if (sent.some((row) => rank(row.threshold) >= rank(threshold)))
      return false;
    const row = await tx.trialNotification.create({
      data: { companyId, trialLastDay: company.trial_last_day, threshold },
      select: { id: true },
    });
    const owners = await tx.membership.findMany({
      where: {
        companyId,
        role: "owner",
        isActive: true,
        user: { emailVerified: true },
      },
      select: { userId: true, user: { select: { email: true } } },
    });
    for (const owner of owners)
      await enqueueEmail(tx, deps.emailSecret, {
        kind: "trial_reminder",
        dedupeKey: `trial_reminder:${companyId}:${lastDay}:${threshold}:${owner.userId}`,
        userId: owner.userId,
        companyId,
        message: reminderEmail(
          owner.user.email,
          threshold,
          lastDay,
          deps.appUrl,
          deps.supportEmail ?? DEFAULT_SUPPORT_EMAIL,
        ),
      });
    log("info", "trial.reminder_queued", {
      notificationId: row.id,
      companyId,
      threshold,
      owners: owners.length,
    });
    return true;
  });
}

/** One pass of `pnpm jobs:run`. A company that fails doesn't stop the others. */
export async function runTrialReminders(
  deps: ReminderDeps,
): Promise<ReminderResult> {
  const now = deps.now?.() ?? new Date();
  // Seven days left means the last day is six days from today.
  const horizon = addDays(sydneyDate(now), 6);
  const companies = await deps.db.company.findMany({
    where: {
      isDemo: false,
      accessMode: "trial",
      trialLastDay: { lte: new Date(`${horizon}T00:00:00Z`) },
    },
    select: { id: true },
  });
  const result: ReminderResult = { sent: 0, failed: 0 };
  for (const { id } of companies) {
    try {
      if (await remindCompany(deps, id, now)) result.sent += 1;
    } catch (error) {
      result.failed += 1;
      log("error", "trial.reminder_failed", {
        companyId: id,
        error: safeError(error),
      });
    }
  }
  return result;
}
