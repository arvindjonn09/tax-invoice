import { randomBytes } from "node:crypto";
import { inflateSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../packages/database/src/generated/prisma/client";
import { createAuth } from "../../apps/web/src/server/auth/config";
import { createCredentialUser } from "../../apps/web/src/server/auth/credentials";
import { createWithPolicy } from "../../apps/web/src/server/authz/policy";
import { downloadHandler } from "../../apps/web/src/server/documents/handlers";
import { MemoryStore } from "../../apps/web/src/server/documents/store";
import { invoiceHandlers } from "../../apps/web/src/server/invoices/handlers";
import {
  type PdfDeps,
  ensureInvoicePdf,
  invoicePdfHandlers,
} from "../../apps/web/src/server/invoices/pdf-store";
import { syntheticAbn } from "../helpers/abn";
import {
  type CommittedDatabase,
  withCommittedDatabase,
} from "../helpers/committed-database";
import { syntheticFactory } from "../helpers/factories";

// #48: PDFs of issued invoices and credit notes, stored privately once at
// issue; regeneration never changes an issued document.
const ORIGIN = "http://127.0.0.1:3000";
const PASSWORD = "correct horse battery staple";
const WHO = ["owner", "accountant", "employee", "outsider"] as const;
type Who = (typeof WHO)[number];
const SECRET = randomBytes(32).toString("hex");

let database: CommittedDatabase;
let db: PrismaClient;
let withPolicy: ReturnType<typeof createWithPolicy>;
let store: MemoryStore | null = new MemoryStore();
let companyId = "";
let customerId = "";
const userIds = {} as Record<Who, string>;
const cookies = {} as Record<Who, Headers>;
const factory = syntheticFactory(0x4848);
const deps: PdfDeps = {
  db: () => db,
  store: () => store,
  secret: () => SECRET,
};

beforeAll(async () => {
  database = await withCommittedDatabase();
  db = database.client;
  const auth = createAuth({
    db,
    secret: randomBytes(32).toString("hex"),
    baseURL: ORIGIN,
    production: false,
  });
  withPolicy = createWithPolicy({
    auth: () => auth,
    db: () => db,
    trustedOrigins: () => [ORIGIN],
  });
  for (const key of WHO)
    userIds[key] = (
      await createCredentialUser(db, {
        email: `${key}@jobflow.invalid`,
        name: `Synthetic ${key}`,
        password: PASSWORD,
      })
    ).id;
  const own = factory.company(userIds.owner);
  const other = factory.company(userIds.outsider);
  for (const [record, owner] of [
    [own, userIds.owner],
    [other, userIds.outsider],
  ] as const)
    await db.$transaction(async (tx) => {
      await tx.company.create({ data: record });
      await tx.membership.create({
        data: factory.membership(record.id, owner),
      });
    });
  companyId = own.id;
  await db.company.update({
    where: { id: companyId },
    data: {
      legalName: "Sample Contracting Pty Ltd",
      abn: syntheticAbn("484800001"),
    },
  });
  await db.companyGstRegistration.create({
    data: {
      companyId,
      createdBy: userIds.owner,
      startsOn: new Date("2025-07-01T00:00:00Z"),
      basis: "cash",
    },
  });
  for (const role of ["accountant", "employee"] as const)
    await db.membership.create({
      data: {
        companyId,
        userId: userIds[role],
        createdBy: userIds.owner,
        role,
      },
    });
  customerId = (
    await db.customer.create({
      data: { companyId, createdBy: userIds.owner, name: "Acme Sample" },
    })
  ).id;
  let ip = 0;
  for (const key of WHO) {
    const response = await auth.handler(
      new Request(`${ORIGIN}/api/auth/sign-in/email`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: ORIGIN,
          "x-forwarded-for": `203.0.113.${(ip += 1)}`,
        },
        body: JSON.stringify({
          email: `${key}@jobflow.invalid`,
          password: PASSWORD,
        }),
      }),
    );
    expect(response.status).toBe(200);
    cookies[key] = new Headers({
      cookie: response.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; "),
    });
  }
}, 120_000);
afterAll(() => database?.release());

let ip = 50;
function call(who: Who, method: string, body?: unknown) {
  const h = new Headers(cookies[who]);
  h.set("origin", ORIGIN);
  // Each call from its own client so link throttling doesn't interfere.
  h.set("x-forwarded-for", `198.51.100.${(ip = (ip % 250) + 1)}`);
  const init: RequestInit = { method, headers: h };
  if (body !== undefined) {
    h.set("content-type", "application/json");
    init.body = JSON.stringify(body);
  }
  return new Request(`${ORIGIN}/api/x`, init);
}
type One = { params: Promise<{ id: string }> };
const one = (id: string): One => ({ params: Promise.resolve({ id }) });
const invoices = () =>
  invoiceHandlers(() => db, {
    afterIssue: (actor, id) => ensureInvoicePdf(deps, actor, id),
  });
const r = () => ({
  create: withPolicy("invoice.write", invoices().create),
  issue: withPolicy<One>("invoice.issue", invoices().issue),
  credit: withPolicy<One>("invoice.issue", invoices().credit),
  pdf: withPolicy<One>("invoice.read", invoicePdfHandlers(deps).link),
});

async function issued(): Promise<{ id: string; reference: string }> {
  const draft = (await (
    await r().create(
      call("accountant", "POST", {
        customerId,
        lines: [
          {
            description: "Synthetic fit-out",
            quantity: "1",
            unitPriceCents: "250000",
            taxCode: "TAXABLE_10",
          },
        ],
      }),
      undefined,
    )
  ).json()) as { id: string };
  const response = await r().issue(
    call("accountant", "POST", { issueDate: "2026-07-15" }),
    one(draft.id),
  );
  expect(response.status).toBe(200);
  return (await response.json()) as { id: string; reference: string };
}

type Link = {
  documentId: string;
  sha256: string;
  url: string;
  expiresAt: string;
  error?: string;
};
const link = async (id: string, who: Who = "accountant") => {
  const response = await r().pdf(call(who, "POST", {}), one(id));
  return { status: response.status, body: (await response.json()) as Link };
};

describe("invoice PDFs (#48)", () => {
  it("stores the PDF privately at issue and hands out short-lived links to it", async () => {
    const before = store!.objects.size;
    const invoice = await issued();
    const stored = await db.invoicePdf.findUniqueOrThrow({
      where: { companyId_invoiceId: { companyId, invoiceId: invoice.id } },
      include: { document: true },
    });
    expect(store!.objects.size).toBe(before + 1);
    expect(stored.document).toMatchObject({
      kind: "other",
      contentType: "application/pdf",
      fileName: `${invoice.reference}.pdf`,
      sha256: stored.sha256,
    });
    const first = await link(invoice.id);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      documentId: stored.documentId,
      sha256: stored.sha256,
    });
    // The signed link downloads exactly the stored bytes, as an attachment.
    const token = first.body.url.split("/").pop()!;
    const file = await downloadHandler({
      db: () => db,
      store: () => store,
      secret: () => SECRET,
    })(new Request(`${ORIGIN}${first.body.url}`), {
      params: Promise.resolve({ token }),
    });
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("application/pdf");
    expect(file.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(file.headers.get("cache-control")).toBe("private, no-store");
    const bytes = new Uint8Array(await file.arrayBuffer());
    expect(Buffer.from(bytes.subarray(0, 5)).toString()).toBe("%PDF-");
    expect(
      await db.auditEvent.count({
        where: {
          companyId,
          targetId: invoice.id,
          action: "invoice.pdf_stored",
        },
      }),
    ).toBe(1);
  });

  it("never regenerates or changes an issued document's PDF", async () => {
    const invoice = await issued();
    const objects = store!.objects.size;
    const links = await Promise.all([
      link(invoice.id),
      link(invoice.id),
      link(invoice.id),
    ]);
    expect(new Set(links.map((l) => l.body.documentId)).size).toBe(1);
    expect(new Set(links.map((l) => l.body.sha256)).size).toBe(1);
    expect(store!.objects.size).toBe(objects);
    expect(
      await db.invoicePdf.count({
        where: { companyId, invoiceId: invoice.id },
      }),
    ).toBe(1);
    // The table is append-only, and drafts can't get a stored PDF.
    await expect(
      db.invoicePdf.updateMany({
        where: { invoiceId: invoice.id },
        data: { sha256: "0".repeat(64) },
      }),
    ).rejects.toThrow();
    await expect(
      db.invoicePdf.deleteMany({ where: { invoiceId: invoice.id } }),
    ).rejects.toThrow();
  });

  it("stores once even when issue-time storage was down", async () => {
    const saved = store;
    store = null;
    const invoice = await issued();
    expect(
      await db.invoicePdf.count({ where: { invoiceId: invoice.id } }),
    ).toBe(0);
    expect((await link(invoice.id)).status).toBe(503);
    store = saved;
    const late = await link(invoice.id);
    expect(late.status).toBe(200);
    // Rendering is deterministic from the frozen snapshot: same bytes.
    const again = await ensureInvoicePdf(
      deps,
      { companyId, userId: userIds.accountant },
      invoice.id,
    );
    expect(again.sha256).toBe(late.body.sha256);
  });

  it("renders a credit note that names the invoice it adjusts", async () => {
    const invoice = await issued();
    const credit = (await (
      await r().credit(call("accountant", "POST", {}), one(invoice.id))
    ).json()) as { id: string };
    expect(
      (
        await r().issue(
          call("accountant", "POST", { issueDate: "2026-07-20" }),
          one(credit.id),
        )
      ).status,
    ).toBe(200);
    const stored = await db.invoicePdf.findUniqueOrThrow({
      where: { companyId_invoiceId: { companyId, invoiceId: credit.id } },
      include: { document: true },
    });
    const bytes = Buffer.from((await store!.get(stored.document.objectKey))!);
    // Text is drawn as hex strings inside Flate-compressed content streams.
    const content = [
      ...bytes.toString("latin1").matchAll(/stream\r?\n([\s\S]*?)endstream/g),
    ]
      .map((match) => {
        try {
          return inflateSync(Buffer.from(match[1]!, "latin1")).toString(
            "latin1",
          );
        } catch {
          return match[1]!;
        }
      })
      .join("\n");
    for (const text of [
      "Adjustment Note",
      "Adjusts invoice",
      invoice.reference,
    ])
      expect(content, text).toContain(
        Buffer.from(text).toString("hex").toUpperCase(),
      );
  });

  it("has no PDF for drafts, and only office roles of the company get one", async () => {
    const draft = (await (
      await r().create(call("accountant", "POST", { customerId }), undefined)
    ).json()) as { id: string };
    expect((await link(draft.id)).status).toBe(409);
    await expect(
      db.invoicePdf.create({
        data: {
          companyId,
          invoiceId: draft.id,
          documentId: (
            await db.document.findFirstOrThrow({ where: { companyId } })
          ).id,
          sha256: "a".repeat(64),
          rendererVersion: "1",
          createdBy: userIds.accountant,
        },
      }),
    ).rejects.toThrow();
    const invoice = await issued();
    expect((await link(invoice.id, "employee")).status).toBe(403);
    expect((await link(invoice.id, "outsider")).status).toBe(404);
    expect((await link(invoice.id, "owner")).status).toBe(200);
  });
});
