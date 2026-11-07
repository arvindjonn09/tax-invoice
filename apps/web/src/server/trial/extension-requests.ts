import { z } from "zod";
import { type PolicyHandler, privateJson } from "../authz/policy";
import { invalid, jsonOrNull } from "../company/handlers";
import { enqueueEmail } from "../email/outbox";
import { clientIp, hit } from "../http/throttle";
import { withAudit } from "../../../../../packages/database/src/index";
import type { PrismaClient } from "../../../../../packages/database/src/generated/prisma/client";
import { log } from "../log";

const WEEK_MS = 7 * 86_400_000;
const DAY_MS = 86_400_000;
const WEEKLY_LIMIT = 3;
// Format characters too: bidi overrides, and U+2028/9 that some clients render as line breaks.
const CONTROL = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;

const Body = z
  .object({ message: z.string().trim().max(1000).optional() })
  .strict();

export type ExtensionRequestDependencies = {
  db: () => PrismaClient;
  emailSecret: () => string;
  appUrl: () => string;
  operatorEmail: () => string | null;
  dispatch: () => void;
};

/** What an owner sees. The approval note stays with the operator (D6). */
export type OwnerRequestView = ReturnType<typeof ownerView>;

function ownerView(row: {
  id: string;
  status: string;
  message: string | null;
  lastDayAtRequest: Date;
  createdAt: Date;
  decidedAt: Date | null;
  newLastDay: Date | null;
  decisionNote: string | null;
  closedReason: string | null;
}) {
  const day = (date: Date | null) => date?.toISOString().slice(0, 10) ?? null;
  return {
    id: row.id,
    status: row.status,
    message: row.message,
    lastDayAtRequest: day(row.lastDayAtRequest),
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    newLastDay: day(row.newLastDay),
    reason: row.status === "declined" ? row.decisionNote : null,
    closedReason: row.status === "closed" ? row.closedReason : null,
  };
}

/** The pending request and the last 10 decisions (API and /settings/trial). */
export async function ownerRequests(db: PrismaClient, companyId: string) {
  const [pending, decisions] = await Promise.all([
    db.trialExtensionRequest.findFirst({
      where: { companyId, status: "pending" },
    }),
    db.trialExtensionRequest.findMany({
      where: { companyId, status: { not: "pending" } },
      orderBy: { decidedAt: "desc" },
      take: 10,
    }),
  ]);
  return {
    pending: pending ? ownerView(pending) : null,
    decisions: decisions.map(ownerView),
  };
}

class Refusal extends Error {
  constructor(readonly response: Response) {
    super("refused");
  }
}

const throttled = (retryAfterSeconds: number) =>
  privateJson(
    {
      error: "You can't send another request yet.",
      code: "request_throttled",
      retryAfterSeconds,
    },
    { status: 429, headers: { "retry-after": String(retryAfterSeconds) } },
  );

/** Quotes each line, so a message can't pass as this email's own wording. */
const quoted = (message: string) =>
  message
    .split(/\r\n|[\r\n\u2028\u2029]/)
    .map((line) => `> ${line.replace(CONTROL, " ")}`)
    .join("\n");

/** Owner side of S14, under `trial.request_extension`. */
export function extensionRequestHandlers(deps: ExtensionRequestDependencies) {
  const list: PolicyHandler<unknown> = async ({ actor }) =>
    privateJson(await ownerRequests(deps.db(), actor.companyId));

  const create: PolicyHandler<unknown> = async ({ actor, request }) => {
    const db = deps.db();
    const ip = clientIp(request.headers) ?? "unknown";
    // S14 AC4: the shared per-user and per-IP limits.
    if (
      (await hit(db, `trial:request:ip:${ip}`, {
        windowSeconds: 3600,
        max: 10,
      })) > 10 ||
      (await hit(db, `trial:request:user:${actor.userId}`, {
        windowSeconds: 3600,
        max: 10,
      })) > 10
    ) {
      return throttled(3600);
    }
    const parsed = Body.safeParse((await jsonOrNull(request)) ?? {});
    if (!parsed.success) return invalid(parsed.error);
    const message = parsed.data.message || null;
    try {
      const created = await withAudit(
        db,
        async (tx, audit) => {
          // The lock is what makes "one pending request" hold under concurrency.
          const [company] = await tx.$queryRaw<
            {
              name: string;
              is_demo: boolean;
              access_mode: string;
              trial_last_day: Date | null;
            }[]
          >`SELECT name, is_demo, access_mode, trial_last_day
            FROM companies WHERE id = ${actor.companyId}::uuid FOR UPDATE`;
          if (
            !company ||
            company.is_demo ||
            company.access_mode !== "trial" ||
            !company.trial_last_day
          ) {
            throw new Refusal(
              privateJson(
                { error: "This company isn't on a trial." },
                { status: 403 },
              ),
            );
          }
          const pending = await tx.trialExtensionRequest.findFirst({
            where: { companyId: actor.companyId, status: "pending" },
            select: { id: true },
          });
          if (pending) {
            throw new Refusal(
              privateJson(
                {
                  error: "A request is already waiting for a decision.",
                  code: "request_pending",
                },
                { status: 409 },
              ),
            );
          }
          const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT now()`;
          const now = clock!.now.getTime();
          const recent = await tx.trialExtensionRequest.findMany({
            where: {
              companyId: actor.companyId,
              createdAt: { gt: new Date(now - WEEK_MS) },
            },
            orderBy: { createdAt: "asc" },
            select: { createdAt: true },
          });
          if (recent.length >= WEEKLY_LIMIT) {
            throw new Refusal(
              throttled(
                Math.ceil(
                  (recent[0]!.createdAt.getTime() + WEEK_MS - now) / 1000,
                ),
              ),
            );
          }
          const declined = await tx.trialExtensionRequest.findFirst({
            where: {
              companyId: actor.companyId,
              status: "declined",
              decidedAt: { gt: new Date(now - DAY_MS) },
            },
            orderBy: { decidedAt: "desc" },
            select: { decidedAt: true },
          });
          if (declined?.decidedAt) {
            throw new Refusal(
              throttled(
                Math.ceil((declined.decidedAt.getTime() + DAY_MS - now) / 1000),
              ),
            );
          }
          const row = await tx.trialExtensionRequest.create({
            data: {
              companyId: actor.companyId,
              requestedBy: actor.userId,
              lastDayAtRequest: company.trial_last_day,
              message,
            },
          });
          await audit({
            companyId: actor.companyId,
            actorUserId: actor.userId,
            action: "trial_extension.requested",
            target: { type: "trial_extension_request", id: row.id },
            after: { hasMessage: message !== null },
          });
          const to = deps.operatorEmail();
          if (to) {
            const owner = await tx.user.findUniqueOrThrow({
              where: { id: actor.userId },
              select: { name: true, email: true },
            });
            const lastDay = company.trial_last_day.toISOString().slice(0, 10);
            await enqueueEmail(tx, deps.emailSecret(), {
              kind: "trial_extension_request",
              dedupeKey: `trial_extension_request:${row.id}`,
              companyId: actor.companyId,
              message: {
                to,
                subject: "JobFlow trial extension request",
                text: [
                  `Company: ${company.name.replace(CONTROL, " ")}`,
                  `Request: ${row.id}`,
                  `Last trial day: ${lastDay}`,
                  `Owner: ${(owner.name ?? "").replace(CONTROL, " ")} <${owner.email}>`,
                  ...(message ? ["", "Message:", quoted(message)] : []),
                  "",
                  `Open: ${deps.appUrl()}/operator/requests/${row.id}`,
                ].join("\n"),
              },
            });
          } else {
            log("error", "trial_extension.operator_email_unset", {
              requestId: row.id,
            });
          }
          return row;
        },
        { readOnlyExemption: "trial_extension_request" },
      );
      deps.dispatch();
      return privateJson(ownerView(created), { status: 201 });
    } catch (error) {
      if (error instanceof Refusal) return error.response;
      throw error;
    }
  };
  return { list, create };
}
