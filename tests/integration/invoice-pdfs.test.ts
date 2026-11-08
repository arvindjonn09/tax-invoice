import { randomBytes } from "node:crypto";
import { crc32, deflateSync, inflateSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../packages/database/src/generated/prisma/client";
import { createAuth } from "../../apps/web/src/server/auth/config";
import { createCredentialUser } from "../../apps/web/src/server/auth/credentials";
import { createWithPolicy } from "../../apps/web/src/server/authz/policy";
import { documentHandlers } from "../../apps/web/src/server/documents/handlers";
import { downloadHandler } from "../../apps/web/src/server/documents/handlers";
import { sha256Hex } from "../../apps/web/src/server/documents/files";
import { MemoryStore } from "../../apps/web/src/server/documents/store";
import { invoiceHandlers } from "../../apps/web/src/server/invoices/handlers";
import {
  type PdfDeps,
  ensureInvoicePdf,
  storePdfAfterResponse,
  invoicePdfHandlers,
} from "../../apps/web/src/server/invoices/pdf-store";
import { SYNTHETIC_ADDRESS, syntheticAbn } from "../helpers/abn";
import {
  type CommittedDatabase,
  withCommittedDatabase,
} from "../helpers/committed-database";
import { syntheticFactory } from "../helpers/factories";
import { operatorUpdate } from "../helpers/operator-update";

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
      ...SYNTHETIC_ADDRESS,
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

  it("refuses a document link to an invoice PDF without invoice.read (#260)", async () => {
    const invoice = await issued();
    await link(invoice.id);
    const stored = await db.invoicePdf.findFirstOrThrow({
      where: { invoiceId: invoice.id },
    });
    // As if the person who triggered the render has since been demoted.
    await db.document.update({
      where: { id: stored.documentId },
      data: { createdBy: userIds.employee },
    });
    const documentLink = withPolicy<One>(
      "document.upload",
      documentHandlers(deps as never).link,
    );
    expect(
      (await documentLink(call("employee", "POST"), one(stored.documentId)))
        .status,
    ).toBe(404);
    expect(
      (await documentLink(call("accountant", "POST"), one(stored.documentId)))
        .status,
    ).toBe(200);
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

describe("read-only company (#222)", () => {
  it("still stores and links the PDF of an already-issued invoice", async () => {
    // Issue without storing the PDF, so the first PDF is made while read-only.
    const noStore = invoiceHandlers(() => db, {
      afterIssue: async () => undefined,
    });
    const draft = (await (
      await withPolicy("invoice.write", noStore.create)(
        call("accountant", "POST", {
          customerId,
          lines: [
            {
              description: "Synthetic read-only PDF",
              quantity: "1",
              unitPriceCents: "100000",
              taxCode: "TAXABLE_10",
            },
          ],
        }),
        undefined,
      )
    ).json()) as { id: string };
    const issuedResponse = await withPolicy<One>(
      "invoice.issue",
      noStore.issue,
    )(call("accountant", "POST", { issueDate: "2026-07-15" }), one(draft.id));
    expect(issuedResponse.status).toBe(200);
    expect(await db.invoicePdf.count({ where: { invoiceId: draft.id } })).toBe(
      0,
    );
    await operatorUpdate(db, {
      where: { id: companyId },
      data: {
        isDemo: false,
        accessMode: "trial",
        trialStartedAt: new Date("2019-12-01T00:00:00Z"),
        trialLastDay: new Date("2020-01-01T00:00:00Z"),
      },
    });
    try {
      // The real route path: the read-only allowlist matches it.
      const request = new Request(
        `${ORIGIN}/api/invoices/${draft.id}/pdf`,
        call("accountant", "POST", {}),
      );
      const response = await r().pdf(request, one(draft.id));
      expect(response.status, await response.clone().text()).toBe(200);
      expect(
        await db.invoicePdf.count({ where: { invoiceId: draft.id } }),
      ).toBe(1);
      expect(
        await db.auditEvent.count({
          where: {
            companyId,
            action: "invoice.pdf_stored",
            targetId: draft.id,
          },
        }),
      ).toBe(1);
    } finally {
      await operatorUpdate(db, {
        where: { id: companyId },
        data: { accessMode: "unrestricted", isDemo: true },
      });
    }
  });
});

describe("issue responds before the PDF is stored (#158)", () => {
  it("schedules storage after the response; running it stores the PDF", async () => {
    const tasks: (() => Promise<unknown>)[] = [];
    const deferred = invoiceHandlers(() => db, {
      afterIssue: storePdfAfterResponse(deps, (task) => tasks.push(task)),
    });
    const draft = (await (
      await r().create(
        call("accountant", "POST", {
          customerId,
          lines: [
            {
              description: "Synthetic deferred PDF",
              quantity: "1",
              unitPriceCents: "10000",
              taxCode: "TAXABLE_10",
            },
          ],
        }),
        undefined,
      )
    ).json()) as { id: string };
    // The scheduled task has not run, so the response can't have waited on it.
    const response = await withPolicy<One>("invoice.issue", deferred.issue)(
      call("accountant", "POST", { issueDate: "2026-07-15" }),
      one(draft.id),
    );
    expect(response.status).toBe(200);
    expect(tasks).toHaveLength(1);
    expect(
      await db.invoicePdf.findFirst({ where: { invoiceId: draft.id } }),
    ).toBeNull();
    await tasks[0]!();
    expect(
      await db.invoicePdf.findFirst({ where: { invoiceId: draft.id } }),
    ).not.toBeNull();
  });

  it("a failed deferred store is logged, never thrown", async () => {
    const tasks: (() => Promise<unknown>)[] = [];
    const deferred = invoiceHandlers(() => db, {
      afterIssue: storePdfAfterResponse(
        { ...deps, store: () => null },
        (task) => tasks.push(task),
      ),
    });
    const draft = (await (
      await r().create(
        call("accountant", "POST", {
          customerId,
          lines: [
            {
              description: "Synthetic unstored PDF",
              quantity: "1",
              unitPriceCents: "10000",
              taxCode: "TAXABLE_10",
            },
          ],
        }),
        undefined,
      )
    ).json()) as { id: string };
    const response = await withPolicy<One>("invoice.issue", deferred.issue)(
      call("accountant", "POST", { issueDate: "2026-07-15" }),
      one(draft.id),
    );
    expect(response.status).toBe(200);
    await expect(tasks[0]!()).resolves.toBeUndefined();
    expect(
      await db.invoicePdf.findFirst({ where: { invoiceId: draft.id } }),
    ).toBeNull();
  });
});

describe("supplier snapshot v2 and logo (#229)", () => {
  /** A real PNG of the given size, so each logo is told apart by /Width. */
  function png(width: number, height: number): Uint8Array {
    const chunk = (type: string, data: Buffer) => {
      const length = Buffer.alloc(4);
      length.writeUInt32BE(data.length);
      const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(crc32(body));
      return Buffer.concat([length, body, crc]);
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
    const rows = Buffer.alloc((width * 3 + 1) * height); // filter 0, black
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(rows)),
      chunk("IEND", Buffer.alloc(0)),
    ]);
  }
  async function storeLogo(
    bytes: Uint8Array,
    owner = companyId,
    createdBy = userIds.owner,
  ): Promise<string> {
    const objectKey = `documents/${owner}/${randomBytes(32).toString("hex")}`;
    await store!.put(objectKey, bytes);
    const document = await db.document.create({
      data: {
        companyId: owner,
        kind: "company_logo",
        objectKey,
        fileName: "logo.png",
        contentType: "image/png",
        sizeBytes: bytes.byteLength,
        sha256: sha256Hex(bytes),
        createdBy,
      },
    });
    return document.id;
  }
  /** Issue without storing the PDF, so it's rendered later. */
  async function issueLater(): Promise<string> {
    const handlers = invoiceHandlers(() => db);
    const create = withPolicy("invoice.write", handlers.create);
    const issue = withPolicy<One>("invoice.issue", handlers.issue);
    const created = (await (
      await create(
        call("accountant", "POST", {
          customerId,
          lines: [
            {
              description: "Synthetic logo job",
              quantity: "1",
              unitPriceCents: "10000",
              taxCode: "TAXABLE_10",
            },
          ],
        }),
        undefined,
      )
    ).json()) as { id: string };
    const response = await issue(
      call("accountant", "POST", { issueDate: "2026-07-15" }),
      one(created.id),
    );
    expect(response.status).toBe(200);
    return created.id;
  }
  async function pdfOf(invoiceId: string) {
    const stored = await ensureInvoicePdf(
      deps,
      { companyId, userId: userIds.accountant },
      invoiceId,
    );
    const document = await db.document.findUniqueOrThrow({
      where: { id: stored.documentId },
    });
    const raw = Buffer.from((await store!.get(document.objectKey))!);
    const content = [
      ...raw.toString("latin1").matchAll(/stream\r?\n([\s\S]*?)endstream/g),
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
    const hex = (text: string) =>
      Buffer.from(text).toString("hex").toUpperCase();
    return {
      stored,
      shows: (text: string) => content.includes(hex(text)),
      raw: raw.toString("latin1"),
    };
  }

  /** Put the shared company back, whatever a test did to it. */
  const restoreCompany = () =>
    db.company.update({
      where: { id: companyId },
      data: {
        legalName: "Sample Contracting Pty Ltd",
        ...SYNTHETIC_ADDRESS,
        phone: null,
        businessEmail: null,
        website: null,
        logoDocumentId: null,
      },
    });

  it("freezes contact details and the logo at issue; later edits change nothing", async () => {
    try {
      const firstLogo = png(3, 2);
      await db.company.update({
        where: { id: companyId },
        data: {
          phone: "02 5550 0101",
          businessEmail: "accounts@sample.invalid",
          website: "https://sample.invalid",
          logoDocumentId: await storeLogo(firstLogo),
        },
      });
      const invoiceId = await issueLater();
      const row = await db.invoice.findUniqueOrThrow({
        where: { id: invoiceId },
      });
      expect(row.supplierSnapshot).toMatchObject({
        v: 2,
        legalName: "Sample Contracting Pty Ltd",
        phone: "02 5550 0101",
        businessEmail: "accounts@sample.invalid",
        website: "https://sample.invalid",
        logo: { sha256: sha256Hex(firstLogo), contentType: "image/png" },
      });

      // Every snapshot field changes after issue, including the logo.
      await db.company.update({
        where: { id: companyId },
        data: {
          legalName: "Renamed Pty Ltd",
          phone: "02 5550 0202",
          businessEmail: "changed@sample.invalid",
          website: "https://changed.sample.invalid",
          addressLine1: "99 Changed Street",
          logoDocumentId: await storeLogo(png(5, 4)),
        },
      });
      const pdf = await pdfOf(invoiceId);
      expect(pdf.stored.rendererVersion).toBe("2");
      for (const text of [
        "Sample Contracting Pty Ltd",
        "Phone 02 5550 0101",
        "accounts@sample.invalid",
        "https://sample.invalid",
      ])
        expect(pdf.shows(text), text).toBe(true);
      for (const text of [
        "Renamed Pty Ltd",
        "Phone 02 5550 0202",
        "changed@sample.invalid",
        "99 Changed Street",
      ])
        expect(pdf.shows(text), text).toBe(false);
      // The issue-time logo (3×2) is embedded; the replacement (5×4) isn't.
      expect(pdf.raw).toMatch(/\/Subtype \/Image[\s\S]*?\/Width 3/);
      expect(pdf.raw).not.toMatch(/\/Width 5/);
      // The view keeps the snapshot too.
      const after = await db.invoice.findUniqueOrThrow({
        where: { id: invoiceId },
      });
      expect(after.supplierSnapshot).toEqual(row.supplierSnapshot);
    } finally {
      await restoreCompany();
    }
  });

  it("leaves out a logo larger than the PDF limit, before decoding it", async () => {
    try {
      await db.company.update({
        where: { id: companyId },
        data: { logoDocumentId: await storeLogo(png(2001, 1)) },
      });
      const invoiceId = await issueLater();
      const pdf = await pdfOf(invoiceId);
      expect(pdf.raw).not.toContain("/Subtype /Image");
      expect(pdf.shows("Sample Contracting Pty Ltd")).toBe(true);
    } finally {
      await restoreCompany();
    }
  });

  it("never embeds another company's logo, even if a snapshot points at it", async () => {
    const other = await db.company.findFirstOrThrow({
      where: { id: { not: companyId } },
      select: { id: true },
    });
    const theirs = png(3, 2);
    const theirLogo = await storeLogo(theirs, other.id, userIds.outsider);
    const invoiceId = await issueLater();
    // A snapshot can't name another company's logo through the app; force
    // one in, past the issued-invoice guard, to pin the read-side check.
    await db.$transaction([
      db.$executeRawUnsafe("ALTER TABLE invoices DISABLE TRIGGER USER"),
      db.$executeRaw`UPDATE invoices SET supplier_snapshot = jsonb_set(supplier_snapshot, '{logo}', ${JSON.stringify(
        {
          documentId: theirLogo,
          sha256: sha256Hex(theirs),
          contentType: "image/png",
        },
      )}::jsonb) WHERE id = ${invoiceId}::uuid`,
      db.$executeRawUnsafe("ALTER TABLE invoices ENABLE TRIGGER USER"),
    ]);
    const pdf = await pdfOf(invoiceId);
    expect(pdf.raw).not.toContain("/Subtype /Image");
  });

  it("leaves out a logo whose stored bytes no longer match the snapshot", async () => {
    const logo = png(3, 2);
    const logoId = await storeLogo(logo);
    await db.company.update({
      where: { id: companyId },
      data: { logoDocumentId: logoId },
    });
    const invoiceId = await issueLater();
    await db.company.update({
      where: { id: companyId },
      data: { logoDocumentId: null },
    });
    const { objectKey } = await db.document.findUniqueOrThrow({
      where: { id: logoId },
    });
    // The object is swapped behind the database's back.
    await store!.put(objectKey, png(7, 7));
    const pdf = await pdfOf(invoiceId);
    expect(pdf.raw).not.toContain("/Subtype /Image");
    expect(pdf.shows("Sample Contracting Pty Ltd")).toBe(true);
  });

  it("an empty optional field leaves no label", async () => {
    await db.company.update({
      where: { id: companyId },
      data: { phone: null, businessEmail: null, website: null },
    });
    const invoiceId = await issueLater();
    const pdf = await pdfOf(invoiceId);
    expect(pdf.shows("Phone")).toBe(false);
    expect(pdf.raw).not.toContain("/Subtype /Image");
  });
});
