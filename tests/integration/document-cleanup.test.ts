import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createDatabaseClient } from "../../packages/database/src/index";
import { randomBytes, randomUUID } from "node:crypto";
import { auditChanges } from "../../packages/database/src/audit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../packages/database/src/generated/prisma/client";
import {
  cleanUnattachedDocuments,
  documentReferences,
} from "../../apps/web/src/server/documents/cleanup";
import { MemoryStore } from "../../apps/web/src/server/documents/store";
import {
  type CommittedDatabase,
  withCommittedDatabase,
} from "../helpers/committed-database";
import { syntheticFactory } from "../helpers/factories";

// #137: uploads never attached to anything are deleted after the grace
// period, object first and audited; attached documents are never touched.
let database: CommittedDatabase;
let db: PrismaClient;
let companyId = "";
let userId = "";
let jobId = "";
const store = new MemoryStore();
const NOW = new Date("2026-10-25T00:00:00Z");
const daysAgo = (days: number) =>
  new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);

beforeAll(async () => {
  database = await withCommittedDatabase();
  db = database.client;
  const factory = syntheticFactory(0x137);
  const user = await db.user.create({ data: factory.user() });
  userId = user.id;
  const company = factory.company(user.id);
  companyId = company.id;
  await db.$transaction(async (tx) => {
    await tx.company.create({ data: company });
    await tx.membership.create({
      data: factory.membership(company.id, user.id),
    });
  });
  const customer = await db.customer.create({
    data: { companyId, createdBy: userId, name: "Synthetic Customer" },
  });
  jobId = (
    await db.job.create({
      data: {
        companyId,
        customerId: customer.id,
        createdBy: userId,
        number: 1,
        reference: "JOB-1",
        title: "Synthetic job",
      },
    })
  ).id;
}, 120_000);

afterAll(() => database?.release());

async function upload(createdAt: Date, kind: "photo" | "other" = "photo") {
  const objectKey = `documents/${companyId}/${randomBytes(32).toString("hex")}`;
  await store.put(objectKey, randomBytes(64));
  return db.document.create({
    data: {
      companyId,
      kind,
      objectKey,
      fileName: "synthetic.jpg",
      contentType: "image/jpeg",
      sizeBytes: 64,
      sha256: "0".repeat(64),
      createdBy: userId,
      createdAt,
    },
  });
}

describe("unattached document cleanup (#137)", () => {
  it("finds every table that references documents in the catalog", async () => {
    const tables = (await documentReferences(db)).map((r) => r.tbl);
    expect(tables).toEqual(
      expect.arrayContaining([
        "expenses",
        "invoice_pdfs",
        "supplier_bills",
        "work_evidence",
      ]),
    );
  });

  it("deletes old unattached uploads with an audit event; keeps recent and attached ones", async () => {
    const old = await upload(daysAgo(8));
    const recent = await upload(daysAgo(2));
    const attached = await upload(daysAgo(30));
    await db.workEvidence.create({
      data: {
        companyId,
        jobId,
        kind: "photo",
        documentId: attached.id,
        submittedBy: userId,
      },
    });

    const preview = await cleanUnattachedDocuments(db, store, {
      now: NOW,
      dryRun: true,
    });
    expect(preview.deleted.map((d) => d.id)).toEqual([old.id]);
    expect(await db.document.count({ where: { id: old.id } })).toBe(1);
    expect(await store.get(old.objectKey)).not.toBeNull();

    const result = await cleanUnattachedDocuments(db, store, { now: NOW });
    expect(result.deleted).toEqual([
      { id: old.id, companyId, kind: "photo", sizeBytes: 64 },
    ]);
    expect(await db.document.count({ where: { id: old.id } })).toBe(0);
    expect(await store.get(old.objectKey)).toBeNull();
    for (const kept of [recent, attached]) {
      expect(await db.document.count({ where: { id: kept.id } })).toBe(1);
      expect(await store.get(kept.objectKey)).not.toBeNull();
    }
    const audit = await db.auditEvent.findFirstOrThrow({
      where: { companyId, targetId: old.id },
    });
    expect(audit.metadata).toMatchObject({ by: "unattached-document-cleanup" });
    expect(audit).toMatchObject({
      action: "document.unattached_deleted",
      targetType: "document",
      createdBy: userId,
    });
    // No file name or storage key in the audit trail.
    expect(JSON.stringify(audit.metadata)).not.toMatch(
      /synthetic\.jpg|documents\//,
    );

    // A second run has nothing left to do.
    expect(
      (await cleanUnattachedDocuments(db, store, { now: NOW })).deleted,
    ).toEqual([]);
  });

  it("never deletes a document that gets attached while the cleanup waits", async () => {
    const doc = await upload(daysAgo(10));
    // An attach in flight holds the row (KEY SHARE via its foreign key);
    // the cleanup waits, then sees it attached and leaves it alone.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let attachedInTx!: () => void;
    const attaching = new Promise<void>((resolve) => (attachedInTx = resolve));
    const attach = db.$transaction(async (tx) => {
      await tx.workEvidence.create({
        data: {
          companyId,
          jobId,
          kind: "photo",
          documentId: doc.id,
          submittedBy: userId,
        },
      });
      attachedInTx();
      await held;
    });
    await attaching;
    const cleanup = cleanUnattachedDocuments(db, store, { now: NOW });
    await new Promise((resolve) => setTimeout(resolve, 300));
    release();
    await attach;
    const result = await cleanup;
    expect(result.deleted.map((d) => d.id)).not.toContain(doc.id);
    // It really waited on the lock and re-checked, rather than missing it.
    expect(result.skipped).toBe(1);
    expect(await db.document.count({ where: { id: doc.id } })).toBe(1);
    expect(await store.get(doc.objectKey)).not.toBeNull();
  });

  it("keeps an upload that was once part of a record (a swapped-out receipt)", async () => {
    const swapped = await upload(daysAgo(12));
    await db.auditEvent.create({
      data: {
        companyId,
        createdBy: userId,
        action: "expense.updated",
        targetType: "expense",
        targetId: jobId,
        // The exact shape withAudit stores for an edited expense.
        metadata: {
          changes: auditChanges(
            { receiptDocumentId: swapped.id },
            { receiptDocumentId: randomUUID() },
          ),
        } as never,
      },
    });
    const result = await cleanUnattachedDocuments(db, store, { now: NOW });
    expect(result.deleted.map((d) => d.id)).not.toContain(swapped.id);
    expect(await store.get(swapped.objectKey)).not.toBeNull();
  });

  it("deletes the file only after the row is gone, and reports files left behind", async () => {
    const stuck = await upload(daysAgo(20));
    const fine = await upload(daysAgo(19));
    const flaky = {
      put: store.put.bind(store),
      get: store.get.bind(store),
      delete: async (key: string) => {
        if (key === stuck.objectKey) throw new Error("storage unavailable");
        return store.delete(key);
      },
    } as unknown as MemoryStore;
    const result = await cleanUnattachedDocuments(db, flaky, { now: NOW });
    expect(result.failed).toBe(0);
    expect(result.objectsLeft).toBe(1);
    expect(result.deleted.map((d) => d.id)).toEqual(
      expect.arrayContaining([stuck.id, fine.id]),
    );
    // No row points to a missing file; the leftover file is unreachable.
    expect(await db.document.count({ where: { id: stuck.id } })).toBe(0);
    expect(await store.get(stuck.objectKey)).not.toBeNull();
    expect(await store.get(fine.objectKey)).toBeNull();
  });

  it("ignores a document id typed into free text in the audit trail", async () => {
    const typed = await upload(daysAgo(15));
    await db.auditEvent.create({
      data: {
        companyId,
        createdBy: userId,
        action: "expense.updated",
        targetType: "expense",
        targetId: jobId,
        // The bare id under a free-text key: only reference keys count.
        metadata: {
          changes: auditChanges({ description: "" }, { description: typed.id }),
        } as never,
      },
    });
    const result = await cleanUnattachedDocuments(db, store, { now: NOW });
    expect(result.deleted.map((d) => d.id)).toContain(typed.id);
  });

  it("refuses a grace period under one day", async () => {
    await expect(
      cleanUnattachedDocuments(db, store, { now: NOW, graceDays: 0 }),
    ).rejects.toThrow(RangeError);
  });

  it("leaves attached documents to the foreign keys too", async () => {
    // The foreign keys are the last line: deleting an attached row fails.
    const doc = await upload(daysAgo(9));
    await db.workEvidence.create({
      data: {
        companyId,
        jobId,
        kind: "photo",
        documentId: doc.id,
        submittedBy: userId,
      },
    });
    await expect(
      db.document.delete({ where: { id: doc.id } }),
    ).rejects.toThrow();
    expect(
      (await cleanUnattachedDocuments(db, store, { now: NOW })).deleted.map(
        (d) => d.id,
      ),
    ).not.toContain(doc.id);
  });
});

describe("durable object deletion and maintenance privilege (#170)", () => {
  it("retries a failed storage delete after the document row has gone", async () => {
    const doc = await upload(daysAgo(30));
    let fail = true;
    const flaky = new Proxy(store, {
      get(target, key) {
        if (key === "delete")
          return async (objectKey: string) => {
            if (fail && objectKey === doc.objectKey)
              throw new Error("Synthetic unavailable");
            return target.delete(objectKey);
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const first = await cleanUnattachedDocuments(db, flaky, { now: NOW });
    expect(first.deleted.map((d) => d.id)).toContain(doc.id);
    expect(first.objectsLeft).toBeGreaterThan(0);
    expect(await db.document.findUnique({ where: { id: doc.id } })).toBeNull();
    expect(
      await db.documentDeleteRetry.findUnique({ where: { id: doc.id } }),
    ).toMatchObject({ companyId, objectKey: doc.objectKey, attemptCount: 1 });
    fail = false;
    await cleanUnattachedDocuments(db, flaky, { now: NOW });
    expect(
      await db.documentDeleteRetry.findUnique({ where: { id: doc.id } }),
    ).toBeNull();
    expect(await store.get(doc.objectKey)).toBeNull();
  });
  it("runs cleanup as a separate maintenance login while the web role cannot delete/read private outbox", async () => {
    const { Client } = createRequire(
      new URL("../../packages/database/package.json", import.meta.url),
    )("pg") as {
      Client: new (args: { connectionString: string }) => {
        connect(): Promise<void>;
        end(): Promise<void>;
        query(sql: string): Promise<unknown>;
      };
    };
    const admin = new Client({ connectionString: database.url });
    await admin.connect();
    const name = `cleanup_${randomUUID().replaceAll("-", "")}`,
      password = randomBytes(24).toString("hex");
    let created = false;
    try {
      for (const file of ["runtime-role.sql", "maintenance-role.sql"])
        await admin.query(
          await readFile(
            new URL(
              `../../packages/database/prisma/roles/${file}`,
              import.meta.url,
            ),
            "utf8",
          ),
        );
      for (const sql of [
        "DELETE FROM documents",
        "SELECT * FROM document_delete_retries",
        "SELECT jobflow_lock_document_for_cleanup(NULL,NULL)",
      ]) {
        await admin.query("BEGIN");
        try {
          await admin.query("SET LOCAL ROLE jobflow_app");
          await expect(admin.query(sql)).rejects.toMatchObject({
            code: "42501",
          });
        } finally {
          await admin.query("ROLLBACK");
        }
      }
      await admin.query(
        `CREATE ROLE ${name} LOGIN INHERIT IN ROLE jobflow_maintenance PASSWORD '${password}'`,
      );
      created = true;
      const url = new URL(database.url);
      url.username = name;
      url.password = password;
      const limited = createDatabaseClient(url.toString());
      const doc = await upload(daysAgo(30));
      try {
        const result = await cleanUnattachedDocuments(limited, store, {
          now: NOW,
        });
        expect(result.deleted.map((d) => d.id)).toContain(doc.id);
        expect(result.failed).toBe(0);
        await expect(
          limited.$queryRaw`SELECT * FROM employee_rate_history`,
        ).rejects.toThrow();
        await expect(
          limited.$executeRaw`UPDATE documents SET file_name=file_name`,
        ).rejects.toThrow();
        await expect(
          limited.$executeRaw`UPDATE audit_events SET action=action`,
        ).rejects.toThrow();
      } finally {
        await limited.$disconnect();
      }
    } finally {
      if (created) await admin.query(`DROP ROLE ${name}`);
      await admin.end();
    }
  });
});
