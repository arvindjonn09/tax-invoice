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

const REQUEST_SELECT = {
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
  requester: { select: { user: { select: { name: true, email: true } } } },
  decider: { select: { user: { select: { email: true } } } },
} satisfies Prisma.TrialExtensionRequestSelect;
type RequestRow = Prisma.TrialExtensionRequestGetPayload<{
  select: typeof REQUEST_SELECT;
}>;

function requestProjection(row: RequestRow, now: Date) {
  return {
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
    company: companyProjection(row.company, now),
    owner: { name: row.requester.user.name, email: row.requester.user.email },
    decidedByEmail: row.decider?.user.email ?? null,
  };
}
export type OperatorRequest = ReturnType<typeof requestProjection>;
export type OperatorCompany = ReturnType<typeof companyProjection>;

/** Pending oldest first, or decided newest first (API and /operator). */
export async function loadRequests(
  db: PrismaClient,
  { decided, page, now }: { decided: boolean; page: number; now: Date },
): Promise<OperatorRequest[]> {
  const rows = await db.trialExtensionRequest.findMany({
    where: decided ? { status: { not: "pending" } } : { status: "pending" },
    orderBy: decided ? { decidedAt: "desc" } : { createdAt: "asc" },
    take: PAGE_SIZE,
    skip: (page - 1) * PAGE_SIZE,
    select: REQUEST_SELECT,
  });
  return rows.map((row) => requestProjection(row, now));
}

export const countPendingRequests = (db: PrismaClient) =>
  db.trialExtensionRequest.count({ where: { status: "pending" } });

/** One request, or null for an unknown or malformed id (/operator/requests/[id]). */
export async function loadRequest(
  db: PrismaClient,
  id: string,
  now: Date,
): Promise<OperatorRequest | null> {
  if (!Id.safeParse(id).success) return null;
  const row = await db.trialExtensionRequest.findUnique({
    where: { id },
    select: REQUEST_SELECT,
  });
  return row ? requestProjection(row, now) : null;
}

/** Non-demo companies by name (API and /operator/companies). */
export async function loadCompanies(
  db: PrismaClient,
  { q, page, now }: { q: string; page: number; now: Date },
): Promise<OperatorCompany[]> {
  const search = q.trim().slice(0, 200);
  const rows = await db.company.findMany({
    where: {
      isDemo: false,
      ...(search ? { name: { contains: search, mode: "insensitive" } } : {}),
    },
    orderBy: { name: "asc" },
    take: PAGE_SIZE,
    skip: (page - 1) * PAGE_SIZE,
    select: COMPANY_SELECT,
  });
  return rows.map((row) => companyProjection(row, now));
}

/** One non-demo company, or null (/operator/companies/[id]). */
export async function loadCompany(
  db: PrismaClient,
  id: string,
  now: Date,
): Promise<OperatorCompany | null> {
  if (!Id.safeParse(id).success) return null;
  const row = await db.company.findFirst({
    where: { id, isDemo: false },
    select: COMPANY_SELECT,
  });
  return row ? companyProjection(row, now) : null;
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
/** A client's malformed id is dropped: the audit writer refuses it outright. */
const auditId = (request: Request) => {
  const id = request.headers.get("x-request-id");
  return id && /^[A-Za-z0-9._:-]{1,100}$/.test(id) ? id : undefined;
};
const page = (url: URL) =>
  Math.max(1, Math.min(10_000, Number(url.searchParams.get("page")) || 1));

export function operatorHandlers(
  deps: () => TrialAccessDependencies & { db: PrismaClient },
) {
  const listRequests: OperatorHandler<unknown> = async ({ request }) => {
    const { db, now } = deps();
    const url = new URL(request.url);
    return privateJson({
      requests: await loadRequests(db, {
        decided: url.searchParams.get("status") === "decided",
        page: page(url),
        now: now?.() ?? new Date(),
      }),
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
    return privateJson({
      companies: await loadCompanies(db, {
        q: url.searchParams.get("q") ?? "",
        page: page(url),
        now: now?.() ?? new Date(),
      }),
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
