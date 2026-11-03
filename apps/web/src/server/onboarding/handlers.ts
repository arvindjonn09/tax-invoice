import { randomUUID } from "node:crypto";
import { sydneyDate, trialWindow } from "@jobflow/domain";
import { z } from "zod";
import type { PrismaClient } from "../../../../../packages/database/src/generated/prisma/client";
import { withAudit } from "../../../../../packages/database/src/index";
import { isVerified } from "../auth/actor";
import type { Auth } from "../auth/config";
import { privateJson } from "../authz/policy";
import { invalid } from "../company/handlers";
import {
  abnField,
  optionalText,
  postcodeField,
  stateField,
} from "../http/fields";
import {
  HttpError,
  readJson,
  requireBodyWithin,
  requireTrustedOrigin,
} from "../http/guards";
import { clientIp, hit } from "../http/throttle";
import { log, safeError } from "../log";

export type OnboardingDependencies = {
  db: () => PrismaClient;
  auth: () => Auth;
  trustedOrigins: () => readonly string[];
  now?: () => Date;
};

const day = z.iso.date("Enter a date");

const Company = z
  .object({
    businessName: z
      .string()
      .trim()
      .min(1, "Enter your business name")
      .max(200, "Use 200 characters or fewer"),
    legalName: optionalText(200).optional(),
    gstRegistered: z.boolean({ error: "Choose whether you're registered" }),
    abn: abnField.optional(),
    gstStartsOn: day.optional(),
    gstBasis: z.enum(["cash", "non_cash"]).optional(),
    basPeriod: z.enum(["monthly", "quarterly"]).default("quarterly"),
    addressLine1: optionalText(200).optional(),
    addressLine2: optionalText(200).optional(),
    suburb: optionalText(100).optional(),
    state: stateField.nullable().optional(),
    postcode: postcodeField.nullable().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.gstRegistered) return;
    if (!value.abn) {
      context.addIssue({
        code: "custom",
        path: ["abn"],
        message: "Enter your ABN. It's required when you're registered for GST",
      });
    }
    if (!value.gstStartsOn) {
      context.addIssue({
        code: "custom",
        path: ["gstStartsOn"],
        message: "Enter the date your GST registration started",
      });
    }
    if (!value.gstBasis) {
      context.addIssue({
        code: "custom",
        path: ["gstBasis"],
        message: "Choose cash or accruals",
      });
    }
  });

const IDEMPOTENCY_KEY = /^[A-Za-z0-9-]{8,100}$/;

function isSelfServiceConflict(error: unknown): boolean {
  const text = JSON.stringify(error, Object.getOwnPropertyNames(error ?? {}));
  return /P2002|23505/.test(text) && /self_service_owner_id/.test(text);
}

/**
 * POST /api/onboarding/company (S5): a verified user with no self-service
 * company creates one, becoming its Owner, with a 30-day trial. Company,
 * membership, GST registration, trial and session switch commit together.
 * Retrying with the same Idempotency-Key returns the same company.
 */
export function createCompany(deps: OnboardingDependencies) {
  return async (request: Request): Promise<Response> => {
    try {
      requireTrustedOrigin(request, deps.trustedOrigins());
      requireBodyWithin(request, 4096);
      const session = await deps
        .auth()
        .api.getSession({ headers: request.headers });
      if (!session) throw new HttpError(401, "Sign in to continue");
      if (!isVerified(session.user)) {
        throw new HttpError(403, "Verify your email address first");
      }
      const key = request.headers.get("idempotency-key") ?? "";
      if (!IDEMPOTENCY_KEY.test(key)) {
        throw new HttpError(400, "Reload the page and try again");
      }
      const db = deps.db();
      const userId = session.user.id;
      if (
        (await hit(
          db,
          `onboarding:${userId}:${clientIp(request.headers) ?? "unknown"}`,
          { windowSeconds: 3600, max: 20 },
        )) > 20
      ) {
        throw new HttpError(429, "Too many attempts. Try again later.");
      }
      const parsed = Company.safeParse(
        await readJson(request, 4096).catch((error: unknown) => {
          if (error instanceof HttpError && error.status !== 400) throw error;
          return null;
        }),
      );
      if (!parsed.success) return invalid(parsed.error);
      const input = parsed.data;

      const existingResponse = async (): Promise<Response | null> => {
        const existing = await db.company.findUnique({
          where: { selfServiceOwnerId: userId },
          select: { id: true, selfServiceRequestKey: true },
        });
        if (!existing) return null;
        if (existing.selfServiceRequestKey === key) {
          return privateJson({ companyId: existing.id }, { status: 200 });
        }
        return privateJson(
          {
            error:
              "You've already set up a company. Contact us to set up another one.",
            code: "self_service_limit",
          },
          { status: 409 },
        );
      };
      const already = await existingResponse();
      if (already) return already;

      const now = deps.now?.() ?? new Date();
      const { lastDay } = trialWindow(now);
      const companyId = randomUUID();
      try {
        await withAudit(db, async (tx, audit) => {
          await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
          const profile = {
            name: input.businessName,
            legalName: input.legalName ?? null,
            abn: input.abn ?? null,
            addressLine1: input.addressLine1 ?? null,
            addressLine2: input.addressLine2 ?? null,
            suburb: input.suburb ?? null,
            state: input.state ?? null,
            postcode: input.postcode ?? null,
            basPeriod: input.basPeriod,
          };
          // The creator FK is deferred, so company and owner commit together.
          await tx.company.create({
            data: {
              id: companyId,
              ...profile,
              isDemo: false,
              createdBy: userId,
              accessMode: "trial",
              trialStartedAt: now,
              trialLastDay: new Date(`${lastDay}T00:00:00Z`),
              selfServiceOwnerId: userId,
              selfServiceRequestKey: key,
            },
          });
          await tx.membership.create({
            data: { companyId, userId, role: "owner", createdBy: userId },
          });
          await audit({
            companyId,
            actorUserId: userId,
            action: "company.created",
            target: { type: "company", id: companyId },
            after: profile,
          });
          if (input.gstRegistered && input.gstStartsOn && input.gstBasis) {
            const registration = await tx.companyGstRegistration.create({
              data: {
                companyId,
                createdBy: userId,
                startsOn: new Date(`${input.gstStartsOn}T00:00:00Z`),
                basis: input.gstBasis,
              },
            });
            await audit({
              companyId,
              actorUserId: userId,
              action: "gst_settings.registration_added",
              target: { type: "company_gst_registration", id: registration.id },
              after: {
                startsOn: input.gstStartsOn,
                endsOn: null,
                basis: input.gstBasis,
              },
            });
          }
          await audit({
            companyId,
            actorUserId: userId,
            action: "trial.started",
            target: { type: "company", id: companyId },
            after: { accessMode: "trial", startedOn: sydneyDate(now), lastDay },
          });
          await tx.authSession.update({
            where: { id: session.session.id },
            data: { activeCompanyId: companyId },
          });
        });
      } catch (error) {
        // A concurrent request created this user's company first.
        if (isSelfServiceConflict(error)) {
          const raced = await existingResponse();
          if (raced) return raced;
        }
        throw error;
      }
      return privateJson({ companyId }, { status: 201 });
    } catch (error) {
      if (error instanceof HttpError) {
        return privateJson({ error: error.message }, { status: error.status });
      }
      const reference = crypto.randomUUID();
      log("error", "onboarding.unhandled", {
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
