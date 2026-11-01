import type {
  AuditEvent,
  Prisma,
  PrismaClient,
} from "./generated/prisma/client";

/** One audited change. `before`/`after` hold only the fields that may change. */
export type AuditEventInput = {
  companyId: string;
  /** The acting user; must hold a membership in `companyId` (database FK). */
  actorUserId: string;
  /** Namespaced, e.g. `membership.role_changed` or `invoice.issued`. */
  action: string;
  target: { type: string; id: string };
  /** Correlates with request logs; never a secret or session token. */
  requestId?: string;
  before?: Readonly<Record<string, unknown>>;
  after?: Readonly<Record<string, unknown>>;
};

export type AuditRecorder = (event: AuditEventInput) => Promise<AuditEvent>;

export const REDACTED = "[redacted]";
/** Sensitive values are never stored; the change itself is still recorded. */
const SENSITIVE_KEY =
  /password|secret|token|session|cookie|bank|bsb|account_?number|card|tfn|abn|email|phone|address/i;
const ACTION = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const TARGET_TYPE = /^[a-z][a-z0-9_]{0,99}$/;
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,100}$/;
const MAX_METADATA_BYTES = 16_384;

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** Plain JSON: bigint money becomes a decimal string, Dates become ISO strings. */
function toJson(value: unknown): Json {
  if (value === undefined) return null;
  return JSON.parse(
    JSON.stringify(value, (_key, item: unknown) =>
      typeof item === "bigint" ? item.toString() : item,
    ),
  ) as Json;
}

function redact(key: string, value: Json): Json {
  if (SENSITIVE_KEY.test(key)) return REDACTED;
  if (Array.isArray(value)) return value.map((item) => redact("", item));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([inner, item]) => [
        inner,
        redact(inner, item),
      ]),
    );
  }
  return value;
}

/** Field-level diff of `before` → `after`, redacted and limited to changed fields. */
export function auditChanges(
  before: Readonly<Record<string, unknown>> = {},
  after: Readonly<Record<string, unknown>> = {},
): Record<string, { before: Json; after: Json }> {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  const changes: Record<string, { before: Json; after: Json }> = {};
  for (const key of keys.sort()) {
    const previous = toJson(before[key]);
    const next = toJson(after[key]);
    if (JSON.stringify(previous) !== JSON.stringify(next)) {
      changes[key] = {
        before: redact(key, previous),
        after: redact(key, next),
      };
    }
  }
  return changes;
}

function auditMetadata(event: AuditEventInput): Prisma.InputJsonObject {
  if (!ACTION.test(event.action)) {
    throw new RangeError(`Invalid audit action "${event.action}"`);
  }
  if (!TARGET_TYPE.test(event.target.type)) {
    throw new RangeError(`Invalid audit target type "${event.target.type}"`);
  }
  if (event.target.id.trim() === "" || event.target.id.length > 200) {
    throw new RangeError("Audit target id must be 1-200 characters");
  }
  if (event.requestId !== undefined && !REQUEST_ID.test(event.requestId)) {
    throw new RangeError("Invalid audit request id");
  }
  const metadata: Prisma.InputJsonObject = {
    ...(event.requestId === undefined ? {} : { requestId: event.requestId }),
    ...(event.before === undefined && event.after === undefined
      ? {}
      : { changes: auditChanges(event.before, event.after) }),
  };
  if (Buffer.byteLength(JSON.stringify(metadata)) > MAX_METADATA_BYTES) {
    throw new RangeError("Audit metadata exceeds 16 KiB");
  }
  return metadata;
}

/**
 * Run `work` and its audit events in ONE database transaction. Events can only
 * be recorded through the `audit` function handed to `work`, so a rolled-back
 * change never leaves an event, and a committed change always has one: the
 * transaction is rejected if `work` records no event. `audit_events` is
 * append-only in the database; this module deliberately offers no update or
 * delete.
 */
export async function withAudit<T>(
  client: PrismaClient,
  work: (tx: Prisma.TransactionClient, audit: AuditRecorder) => Promise<T>,
  /** e.g. RepeatableRead, so an export reads one snapshot (#56). */
  options?: { isolationLevel?: Prisma.TransactionIsolationLevel },
): Promise<T> {
  return client.$transaction(async (tx) => {
    let recorded = 0;
    const audit: AuditRecorder = async (event) => {
      const created = await tx.auditEvent.create({
        data: {
          companyId: event.companyId,
          createdBy: event.actorUserId,
          action: event.action,
          targetType: event.target.type,
          targetId: event.target.id,
          metadata: auditMetadata(event),
        },
      });
      recorded += 1;
      return created;
    };
    const result = await work(tx, audit);
    if (recorded === 0) {
      throw new Error("Audited transaction recorded no audit event");
    }
    return result;
  }, options);
}

/** Company-scoped audit history, newest first (read-only). */
export function listAuditEvents(
  client: PrismaClient | Prisma.TransactionClient,
  query: {
    companyId: string;
    target?: { type: string; id: string };
    take?: number;
  },
): Promise<AuditEvent[]> {
  const take = query.take ?? 50;
  if (!Number.isInteger(take) || take < 1 || take > 100) {
    throw new RangeError("take must be an integer from 1 to 100");
  }
  return client.auditEvent.findMany({
    where: {
      companyId: query.companyId,
      ...(query.target
        ? { targetType: query.target.type, targetId: query.target.id }
        : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take,
  });
}
