import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client";

/** Server-only adapter factory; application authorisation remains in service policies. */
export function createDatabaseAdapter(connectionString: string): PrismaPg {
  return new PrismaPg({
    connectionString,
    max: 5,
    connectionTimeoutMillis: 5000,
  });
}

/** Create once per server process; callers must disconnect short-lived test clients. */
export function createDatabaseClient(connectionString: string): PrismaClient {
  return new PrismaClient({ adapter: createDatabaseAdapter(connectionString) });
}

export {
  REDACTED,
  auditChanges,
  listAuditEvents,
  withAudit,
  type AuditEventInput,
  type AuditRecorder,
} from "./audit";
