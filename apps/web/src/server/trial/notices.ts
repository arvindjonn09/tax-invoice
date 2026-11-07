import {
  type TrialThreshold,
  trialStatus,
  trialThreshold,
} from "@jobflow/domain";
import { z } from "zod";
import type { PrismaClient } from "../../../../../packages/database/src/generated/prisma/client";
import { isVerified } from "../auth/actor";
import type { Auth } from "../auth/config";
import { privateJson } from "../authz/policy";
import { invalid } from "../company/handlers";
import {
  HttpError,
  readJson,
  requireBodyWithin,
  requireTrustedOrigin,
} from "../http/guards";
import { log, safeError } from "../log";
import { formatTrialDay } from "./reminders";

// #233 (S10 AC3, S14 AC9; docs/design/signup-trial.md §12a). One-time notices
// for owners of a company on trial. A threshold notice counts as seen once
// shown; an extension notice stays until it's dismissed.

export type ShownNotice = {
  noticeKey: string;
  text: string;
  /** Offer "Request extension". */
  canRequest: boolean;
};

const KEY_PART: Record<TrialThreshold, string> = {
  d7: "7",
  d3: "3",
  d1: "1",
  ended: "ended",
};

export function thresholdNoticeText(
  threshold: TrialThreshold,
  lastDay: string,
  daysRemaining: number,
  support: string,
): string {
  const day = formatTrialDay(lastDay);
  switch (threshold) {
    case "d7":
      return `Your trial ends on ${day}. Request an extension in Settings → Trial, or email ${support}.`;
    case "d3":
      return `${daysRemaining} days left in your trial. After ${day} your company becomes read-only.`;
    case "d1":
      return "Today is the last day of your trial. Your company becomes read-only from 12:00 am tomorrow (Sydney time).";
    case "ended":
      return `Your trial ended on ${day}. You can still view and export your records. Request an extension to keep working.`;
  }
}

export async function loadNotices(
  db: PrismaClient,
  input: {
    userId: string;
    companyId: string;
    role: string;
    isDemo: boolean;
    trialLastDay: string | null;
    support: string;
    now: Date;
  },
): Promise<ShownNotice[]> {
  if (input.role !== "owner" || input.isDemo || !input.trialLastDay) return [];
  const { userId, companyId, trialLastDay } = input;
  const shown: ShownNotice[] = [];
  const rows = await db.userNotice.findMany({
    where: {
      userId,
      companyId,
      dismissedAt: null,
      OR: [
        { noticeKey: { startsWith: "trial.extended:" } },
        { noticeKey: { startsWith: "trial.declined:" } },
      ],
    },
    orderBy: { createdAt: "asc" },
    select: { noticeKey: true },
  });
  for (const { noticeKey } of rows) {
    const [kind, value = ""] = noticeKey.split(":");
    if (kind === "trial.extended")
      shown.push({
        noticeKey,
        text: `Your trial was extended to ${formatTrialDay(value)}.`,
        canRequest: false,
      });
    else {
      const request = await db.trialExtensionRequest.findFirst({
        where: { id: value, companyId },
        select: { decisionNote: true },
      });
      shown.push({
        noticeKey,
        text: request?.decisionNote
          ? `Your extension request was declined: ${request.decisionNote}`
          : "Your extension request was declined.",
        canRequest: false,
      });
    }
  }
  const { daysRemaining } = trialStatus(trialLastDay, input.now);
  const threshold = trialThreshold(daysRemaining);
  if (threshold) {
    const noticeKey = `trial.threshold.${KEY_PART[threshold]}:${trialLastDay}`;
    // Recording it first means two tabs or a retry can't show it twice.
    const { count } = await db.userNotice.createMany({
      data: { userId, companyId, noticeKey, dismissedAt: input.now },
      skipDuplicates: true,
    });
    if (count === 1)
      shown.push({
        noticeKey,
        text: thresholdNoticeText(
          threshold,
          trialLastDay,
          daysRemaining,
          input.support,
        ),
        canRequest: true,
      });
  }
  return shown;
}

const Dismiss = z
  .object({
    noticeKey: z.string().min(1).max(100),
    companyId: z.uuid().nullable().optional(),
  })
  .strict();

/**
 * POST /api/notices/dismiss. Session-only, as a notice can be account-level:
 * it changes only the caller's own row, and answers 204 whether or not one
 * exists, so it says nothing about other accounts or companies.
 */
export function dismissNotice(deps: {
  db: () => PrismaClient;
  auth: () => Auth;
  trustedOrigins: () => readonly string[];
  now?: () => Date;
}) {
  return async (request: Request): Promise<Response> => {
    try {
      requireTrustedOrigin(request, deps.trustedOrigins());
      requireBodyWithin(request, 4096);
      const session = await deps
        .auth()
        .api.getSession({ headers: request.headers });
      if (!session) throw new HttpError(401, "Sign in to continue");
      if (!isVerified(session.user))
        throw new HttpError(403, "Verify your email address first");
      const parsed = Dismiss.safeParse(
        await readJson(request, 4096).catch((error: unknown) => {
          if (error instanceof HttpError && error.status !== 400) throw error;
          return null;
        }),
      );
      if (!parsed.success) return invalid(parsed.error);
      await deps.db().userNotice.updateMany({
        where: {
          userId: session.user.id,
          companyId: parsed.data.companyId ?? null,
          noticeKey: parsed.data.noticeKey,
          dismissedAt: null,
        },
        data: { dismissedAt: deps.now?.() ?? new Date() },
      });
      return new Response(null, {
        status: 204,
        headers: { "cache-control": "private, no-store" },
      });
    } catch (error) {
      if (error instanceof HttpError)
        return privateJson({ error: error.message }, { status: error.status });
      const reference = crypto.randomUUID();
      log("error", "notices.dismiss_failed", {
        reference,
        error: safeError(error),
      });
      return privateJson(
        { error: "Something went wrong. Try again.", reference },
        { status: 500 },
      );
    }
  };
}
