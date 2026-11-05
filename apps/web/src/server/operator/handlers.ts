import { trialStatus } from "@jobflow/domain";
import { z } from "zod";
import type {
  Prisma,
  PrismaClient,
} from "../../../../../packages/database/src/generated/prisma/client";
import { privateJson } from "../authz/policy";
import { invalid, jsonOrNull } from "../company/handlers";
import type { OperatorHandler } from "./policy";
import {
  TrialAccessError,
  type TrialAccessDependencies,
  approveExtensionRequest,
  declineExtensionRequest,
  extendTrial,
  setAccessMode,
} from "./trial-access";

const PAGE_SIZE = 20;
type IdContext = { params: Promise<{ id: string }> };

const Approve = z
  .object({
    days: z.number().int().min(1).max(365),
    note: z.string().trim().max(500).optional(),
  })
  .strict();
const Decline = z
  .object({ reason: z.string().trim().min(1).max(500) })
  .strict();
const Extend = z
  .object({ lastDay: z.string().max(10), reason: z.string().max(500) })
  .strict();
const Access = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("unrestricted"),
      reason: z.string().max(500),
    })
    .strict(),
  z
    .object({
      mode: z.literal("trial"),
      lastDay: z.string().max(10),
      reason: z.string().max(500),
    })
    .strict(),
]);
const Id = z.uuid();

const COMPANY_SELECT = {
  id: true,
  name: true,
  createdAt: true,
  accessMode: true,
  trialLastDay: true,
} satisfies Prisma.CompanySelect;
type CompanyRow = Prisma.CompanyGetPayload<{ select: typeof COMPANY_SELECT }>;

/** S11 AC2: the least the operator needs, and no business data (key-set test). */
export function companyProjection(company: CompanyRow, now: Date) {
  const lastDay = company.trialLastDay?.toISOString().slice(0, 10) ?? null;
  return {
    id: company.id,
    name: company.name,
    createdAt: company.createdAt.toISOString(),
    mode: company.accessMode,
    lastDay,
    phase:
      company.accessMode === "trial" && lastDay
        ? trialStatus(lastDay, now).phase
        : null,
  };
}

const REFUSAL_STATUS: Record<TrialAccessError["code"], number> = {
  unknown_company: 400,
  demo_company: 400,
  not_on_trial: 400,
  already_in_mode: 400,
  invalid_date: 400,
  invalid_reason: 400,
  invalid_days: 400,
  unknown_request: 400,
  already_decided: 409,
};

const refused = (error: unknown) => {
  if (error instanceof TrialAccessError) {
    return privateJson(
      { error: error.message, code: error.code },
      { status: REFUSAL_STATUS[error.code] },
    );
  }
  throw error;
};
const auditId = (request: Request) =>
  request.headers.get("x-request-id") ?? undefined;
const page = (url: URL) =>
  Math.max(1, Math.min(10_000, Number(url.searchParams.get("page")) || 1));

export function operatorHandlers(
  deps: () => TrialAccessDependencies & { db: PrismaClient },
) {
  const listRequests: OperatorHandler<unknown> = async ({ request }) => {
    const { db, now } = deps();
    const url = new URL(request.url);
    const decided = url.searchParams.get("status") === "decided";
    const rows = await db.trialExtensionRequest.findMany({
      where: decided ? { status: { not: "pending" } } : { status: "pending" },
      orderBy: decided ? { decidedAt: "desc" } : { createdAt: "asc" },
      take: PAGE_SIZE,
      skip: (page(url) - 1) * PAGE_SIZE,
      select: {
        id: true,
        status: true,
        message: true,
        lastDayAtRequest: true,
        createdAt: true,
        decidedAt: true,
        extensionDays: true,
        decisionNote: true,
        newLastDay: true,
        closedReason: true,
        company: { select: COMPANY_SELECT },
        requester: {
          select: { user: { select: { name: true, email: true } } },
        },
      },
    });
    const at = now?.() ?? new Date();
    return privateJson({
      requests: rows.map((row) => ({
        id: row.id,
        status: row.status,
        message: row.message,
        lastDayAtRequest: row.lastDayAtRequest.toISOString().slice(0, 10),
        createdAt: row.createdAt.toISOString(),
        decidedAt: row.decidedAt?.toISOString() ?? null,
        extensionDays: row.extensionDays,
        decisionNote: row.decisionNote,
        newLastDay: row.newLastDay?.toISOString().slice(0, 10) ?? null,
        closedReason: row.closedReason,
        company: companyProjection(row.company, at),
        owner: {
          name: row.requester.user.name,
          email: row.requester.user.email,
        },
      })),
    });
  };

  const approve: OperatorHandler<IdContext> = async ({
    operatorUserId,
    request,
    context,
  }) => {
    const { id } = await context.params;
    const parsed = Approve.safeParse(await jsonOrNull(request));
    if (!parsed.success) return invalid(parsed.error);
    if (!Id.safeParse(id).success) return unknownRequest();
    return approveExtensionRequest(deps(), {
      operatorUserId,
      requestId: id,
      days: parsed.data.days,
      note: parsed.data.note,
      auditRequestId: auditId(request),
    }).then((result) => privateJson(result), refused);
  };

  const decline: OperatorHandler<IdContext> = async ({
    operatorUserId,
    request,
    context,
  }) => {
    const { id } = await context.params;
    const parsed = Decline.safeParse(await jsonOrNull(request));
    if (!parsed.success) return invalid(parsed.error);
    if (!Id.safeParse(id).success) return unknownRequest();
    return declineExtensionRequest(deps(), {
      operatorUserId,
      requestId: id,
      reason: parsed.data.reason,
      auditRequestId: auditId(request),
    }).then(() => privateJson({ status: "declined" }), refused);
  };

  const listCompanies: OperatorHandler<unknown> = async ({ request }) => {
    const { db, now } = deps();
    const url = new URL(request.url);
    const q = url.searchParams.get("q")?.trim().slice(0, 200);
    const rows = await db.company.findMany({
      where: {
        isDemo: false,
        ...(q ? { name: { contains: q, mode: "insensitive" } } : {}),
      },
      orderBy: { name: "asc" },
      take: PAGE_SIZE,
      skip: (page(url) - 1) * PAGE_SIZE,
      select: COMPANY_SELECT,
    });
    const at = now?.() ?? new Date();
    return privateJson({
      companies: rows.map((row) => companyProjection(row, at)),
    });
  };

  const extend: OperatorHandler<IdContext> = async ({
    operatorUserId,
    request,
    context,
  }) => {
    const { id } = await context.params;
    const parsed = Extend.safeParse(await jsonOrNull(request));
    if (!parsed.success) return invalid(parsed.error);
    if (!Id.safeParse(id).success) return unknownCompany();
    const requestId = auditId(request);
    return extendTrial(deps(), {
      operatorUserId,
      companyId: id,
      ...parsed.data,
      ...(requestId ? { requestId } : {}),
    }).then((result) => privateJson(result), refused);
  };

  const access: OperatorHandler<IdContext> = async ({
    operatorUserId,
    request,
    context,
  }) => {
    const { id } = await context.params;
    const parsed = Access.safeParse(await jsonOrNull(request));
    if (!parsed.success) return invalid(parsed.error);
    if (!Id.safeParse(id).success) return unknownCompany();
    const requestId = auditId(request);
    return setAccessMode(deps(), {
      operatorUserId,
      companyId: id,
      ...parsed.data,
      ...(requestId ? { requestId } : {}),
    }).then(() => privateJson({ mode: parsed.data.mode }), refused);
  };

  return { listRequests, approve, decline, listCompanies, extend, access };
}

const unknownRequest = () =>
  privateJson(
    { error: "No request has that ID", code: "unknown_request" },
    { status: 400 },
  );
const unknownCompany = () =>
  privateJson(
    { error: "No company has that ID", code: "unknown_company" },
    { status: 400 },
  );
