import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../packages/database/src/generated/prisma/client";
import { createAuth } from "../../apps/web/src/server/auth/config";
import { createCredentialUser } from "../../apps/web/src/server/auth/credentials";
import { createWithPolicy } from "../../apps/web/src/server/authz/policy";
import { companyHandlers } from "../../apps/web/src/server/company/handlers";
import {
  LOGO_BODY_LIMIT,
  logoHandlers,
} from "../../apps/web/src/server/company/logo";
import { MAX_LOGO_BYTES } from "../../apps/web/src/server/company/logo-image";
import { cleanUnattachedDocuments } from "../../apps/web/src/server/documents/cleanup";
import {
  documentHandlers,
  downloadHandler,
} from "../../apps/web/src/server/documents/handlers";
import { MemoryStore } from "../../apps/web/src/server/documents/store";
import {
  type CommittedDatabase,
  withCommittedDatabase,
} from "../helpers/committed-database";
import { clamdScanner } from "../../apps/web/src/server/documents/scanner";
import { syntheticFactory } from "../helpers/factories";
import {
  type FakeClamd,
  TEST_MARKER,
  startFakeClamd,
} from "../helpers/fake-clamd";
import { jpeg, jpegSegment, png, pngChunk } from "../helpers/logo-fixtures";

// #227 (S6): profile extras and the logo. Refused files leave nothing behind,
// replaced logos stay, and access stays inside the company.
const ORIGIN = "http://127.0.0.1:3000";
const PASSWORD = "correct horse battery staple";
const SECRET = randomBytes(32).toString("hex");
const WHO = ["owner", "accountant", "worker", "outsider", "expired"] as const;
type Who = (typeof WHO)[number];

let database: CommittedDatabase;
let db: PrismaClient;
let withPolicy: ReturnType<typeof createWithPolicy>;
const store = new MemoryStore();
const deps = {
  db: () => db,
  store: () => store,
  secret: () => SECRET,
  // Scanning has its own tests below (#136).
  scanner: () => ({ required: false, scanner: null, disabled: false }),
};
const logos = logoHandlers(deps);
const documents = documentHandlers(deps);
const download = downloadHandler(deps);
const userIds = {} as Record<Who, string>;
const cookies = {} as Record<Who, Headers>;
let companyId = "";
const factory = syntheticFactory(0x2270);

beforeAll(async () => {
  database = await withCommittedDatabase();
  db = database.client;
  const auth = createAuth({
    db,
    secret: SECRET,
    baseURL: ORIGIN,
    production: false,
  });
  withPolicy = createWithPolicy({
    auth: () => auth,
    db: () => db,
    trustedOrigins: () => [ORIGIN],
  });
  for (const key of WHO) {
    userIds[key] = (
      await createCredentialUser(db, {
        email: `${key}@jobflow.invalid`,
        name: `Synthetic ${key}`,
        password: PASSWORD,
      })
    ).id;
  }
  for (const owner of ["owner", "outsider", "expired"] as const) {
    const record = factory.company(userIds[owner]);
    if (owner === "owner") companyId = record.id;
    await db.$transaction(async (tx) => {
      await tx.company.create({
        data:
          owner === "expired"
            ? {
                ...record,
                isDemo: false,
                accessMode: "trial",
                trialStartedAt: new Date("2019-12-01T00:00:00Z"),
                trialLastDay: new Date("2020-01-01T00:00:00Z"),
              }
            : record,
      });
      await tx.membership.create({
        data: factory.membership(record.id, userIds[owner]),
      });
    });
  }
  for (const [key, role] of [
    ["accountant", "accountant"],
    ["worker", "employee"],
  ] as const) {
    await db.membership.create({
      data: { companyId, userId: userIds[key], createdBy: userIds.owner, role },
    });
  }
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
}, 90_000);
afterAll(() => database?.release());

function send(
  who: Who,
  method: string,
  path: string,
  body?: BodyInit,
  type?: string,
): Request {
  const headers = new Headers(cookies[who]);
  headers.set("origin", ORIGIN);
  if (type) headers.set("content-type", type);
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers,
    ...(body ? { body } : {}),
  });
}
function logoRequest(who: Who, file: Uint8Array, name = "logo.png") {
  const form = new FormData();
  form.set("file", new File([Buffer.from(file)], name));
  return send(who, "POST", "/api/company/logo", form);
}
const uploadLogo = (request: Request, handlers = logos) =>
  withPolicy("company.update", handlers.upload, {
    maxBodyBytes: LOGO_BODY_LIMIT,
  })(request, undefined);
const clearLogo = (who: Who) =>
  withPolicy("company.update", logos.remove)(
    send(who, "DELETE", "/api/company/logo"),
    undefined,
  );
const logoLink = (who: Who) =>
  withPolicy("company.read", logos.link)(
    send(who, "GET", "/api/company/logo/link"),
    undefined,
  );
const patchCompany = (who: Who, body: unknown) =>
  withPolicy("company.update", companyHandlers(() => db).update)(
    send(
      who,
      "PATCH",
      "/api/company",
      JSON.stringify(body),
      "application/json",
    ),
    undefined,
  );
const readCompany = async (who: Who) =>
  (await withPolicy("company.read", companyHandlers(() => db).read)(
    send(who, "GET", "/api/company"),
    undefined,
  ).then((r) => r.json())) as Record<string, unknown>;
const fetchFile = (url: string) =>
  download(new Request(`${ORIGIN}${url}`), {
    params: Promise.resolve({ token: url.split("/").pop()! }),
  });
const counts = async () => ({
  objects: store.objects.size,
  documents: await db.document.count(),
  logo: (await db.company.findUniqueOrThrow({ where: { id: companyId } }))
    .logoDocumentId,
});

describe("company profile extras (#227)", () => {
  it("saves phone, email, website and about, and redacts them in the audit", async () => {
    const response = await patchCompany("owner", {
      phone: "+61 (02) 5550 0100",
      businessEmail: "office@sample.invalid",
      website: "HTTPS://sample.invalid/about",
      about: "Call 02 5550 0100.\n<b>Licensed</b> since 2010.",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      phone: "+61 (02) 5550 0100",
      businessEmail: "office@sample.invalid",
      website: "https://sample.invalid/about",
      about: "Call 02 5550 0100.\n<b>Licensed</b> since 2010.",
    });
    const event = await db.auditEvent.findFirstOrThrow({
      where: { companyId, action: "company.profile_updated" },
      orderBy: { createdAt: "desc" },
    });
    expect(event.metadata).toMatchObject({
      changes: {
        phone: { after: "[redacted]" },
        businessEmail: { after: "[redacted]" },
        about: { after: "[redacted]" },
        website: { after: "https://sample.invalid/about" },
      },
    });
    expect(JSON.stringify(event.metadata)).not.toContain("5550");
    expect(JSON.stringify(event.metadata)).not.toContain("office@");
  });

  it("removes control and bidi characters from about, keeping line breaks", async () => {
    const response = await patchCompany("owner", {
      about: "One\u202e\u0007\u200b line\nTwo\u2028",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ about: "One line\nTwo" });
  });

  it("clears a field with a blank value", async () => {
    await patchCompany("owner", { phone: "02 5550 0100" });
    const response = await patchCompany("owner", {
      phone: "  ",
      businessEmail: "",
      website: "",
      about: "",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      phone: null,
      businessEmail: null,
      website: null,
      about: null,
    });
  });

  it.each([
    [{ phone: "1234567" }, "phone"],
    [{ phone: "1234567890123456" }, "phone"],
    [{ phone: "02-5550-0100" }, "phone"],
    [{ phone: "((((((((" }, "phone"],
    [{ businessEmail: "not an email" }, "businessEmail"],
    [{ businessEmail: `${"a".repeat(320)}@sample.invalid` }, "businessEmail"],
    [{ website: "javascript:alert(1)" }, "website"],
    [{ website: "ftp://sample.invalid" }, "website"],
    [{ website: "sample.invalid" }, "website"],
    [{ website: "https://" }, "website"],
    [{ website: "https://exa\nmple.invalid" }, "website"],
    [{ website: "https://exa\tmple.invalid" }, "website"],
    [{ website: "https://sample.invalid/a b" }, "website"],
    [{ website: "https://sample.invalid/\u202e" }, "website"],
    [{ website: "https://user:pass@sample.invalid" }, "website"],
    [{ website: `https://sample.invalid/${"a".repeat(200)}` }, "website"],
    [{ about: "a".repeat(1001) }, "about"],
  ])("refuses %j", async (body, field) => {
    const response = await patchCompany("owner", body);
    expect(response.status).toBe(400);
    const { fields } = (await response.json()) as {
      fields: Record<string, string>;
    };
    expect(fields).toHaveProperty(field);
  });

  it("shows the contact details only to those who manage settings", async () => {
    await patchCompany("owner", { phone: "02 5550 0100" });
    expect(await readCompany("accountant")).toMatchObject({
      phone: "02 5550 0100",
    });
    expect(await readCompany("worker")).not.toHaveProperty("phone");
  });

  it("refuses edits from anyone but the owner, and while read-only", async () => {
    for (const who of ["accountant", "worker"] as const)
      expect((await patchCompany(who, { about: "x" })).status).toBe(403);
    const refused = await patchCompany("expired", { about: "x" });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "company_read_only" });
  });
});

describe("company logo upload (#227)", () => {
  it("stores a PNG without its metadata, sets it and audits it", async () => {
    const tagged = png(
      { width: 32, height: 16 },
      pngChunk("tEXt", Buffer.from("Comment\0GPS -33.86 151.20")),
      pngChunk("eXIf", Buffer.from("Canon EOS")),
    );
    const response = await uploadLogo(logoRequest("owner", tagged));
    expect(response.status).toBe(201);
    const body = (await response.json()) as { id: string; sizeBytes: number };
    expect(body).toMatchObject({
      contentType: "image/png",
      width: 32,
      height: 16,
    });
    const row = await db.document.findUniqueOrThrow({ where: { id: body.id } });
    expect(row).toMatchObject({
      companyId,
      kind: "company_logo",
      contentType: "image/png",
      fileName: "logo.png",
      sizeBytes: png({ width: 32, height: 16 }).length,
    });
    expect(row.objectKey).toMatch(
      new RegExp(`^documents/${companyId}/[0-9a-f]{64}$`),
    );
    const stored = Buffer.from(store.objects.get(row.objectKey)!);
    expect(stored.equals(png({ width: 32, height: 16 }))).toBe(true);
    expect((await counts()).logo).toBe(body.id);
    const event = await db.auditEvent.findFirstOrThrow({
      where: {
        companyId,
        action: "company.logo_changed",
        targetType: "company",
      },
      orderBy: { createdAt: "desc" },
    });
    expect(JSON.stringify(event.metadata)).toContain(body.id);
  });

  it("stores a JPEG without its EXIF", async () => {
    const file = jpeg(
      { width: 40, height: 30 },
      jpegSegment(0xe1, Buffer.from("Exif\0\0GPS -33.86")),
      jpegSegment(0xfe, Buffer.from("taken by a synthetic person")),
    );
    const response = await uploadLogo(logoRequest("owner", file, "photo.jpeg"));
    expect(response.status).toBe(201);
    const { id } = (await response.json()) as { id: string };
    const row = await db.document.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({
      contentType: "image/jpeg",
      fileName: "photo.jpg",
    });
    expect(
      Buffer.from(store.objects.get(row.objectKey)!).equals(
        jpeg({ width: 40, height: 30 }),
      ),
    ).toBe(true);
  });

  it.each<[string, Uint8Array, string, number]>([
    [
      "SVG",
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'),
      "logo.svg",
      415,
    ],
    ["renamed HTML", Buffer.from("<!doctype html><script/>"), "logo.png", 415],
    [
      "a PNG with a page appended",
      Buffer.concat([png(), Buffer.from("<script>")]),
      "logo.png",
      415,
    ],
    [
      "a JPEG with a zip appended",
      Buffer.concat([jpeg(), Buffer.from("PK\x03\x04")]),
      "logo.jpg",
      415,
    ],
    ["a bomb PNG", png({ width: 60_000, height: 60_000 }), "logo.png", 422],
    ["a bomb JPEG", jpeg({ width: 60_000, height: 60_000 }), "logo.jpg", 422],
    [
      "a file over 2 MiB",
      png({}, pngChunk("tEXt", Buffer.alloc(MAX_LOGO_BYTES))),
      "logo.png",
      413,
    ],
    ["an empty file", new Uint8Array(), "logo.png", 400],
  ])("refuses %s and leaves nothing behind", async (_n, file, name, status) => {
    const before = await counts();
    const response = await uploadLogo(logoRequest("owner", file, name));
    expect(response.status).toBe(status);
    expect(await counts()).toEqual(before);
  });

  it("refuses a body far over the limit before reading it", async () => {
    const headers = new Headers(cookies.owner);
    headers.set("origin", ORIGIN);
    headers.set("content-type", "multipart/form-data; boundary=x");
    headers.set("content-length", String(LOGO_BODY_LIMIT + 1));
    const response = await uploadLogo(
      new Request(`${ORIGIN}/api/company/logo`, {
        method: "POST",
        headers,
        body: "x",
      }),
    );
    expect(response.status).toBe(413);
  });

  it("refuses a chunked body that passes the size header check", async () => {
    const parts = [new Uint8Array(LOGO_BODY_LIMIT + 1)];
    const headers = new Headers(cookies.owner);
    headers.set("origin", ORIGIN);
    headers.set("content-type", "multipart/form-data; boundary=x");
    const response = await uploadLogo(
      new Request(`${ORIGIN}/api/company/logo`, {
        method: "POST",
        headers,
        body: new ReadableStream({
          pull(controller) {
            const next = parts.shift();
            if (next) controller.enqueue(next);
            else controller.close();
          },
        }),
        duplex: "half",
      } as RequestInit),
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: "Logos can be at most 2 MB",
    });
  });

  it("is for owners only", async () => {
    const before = await counts();
    for (const who of ["accountant", "worker"] as const) {
      expect((await uploadLogo(logoRequest(who, png()))).status).toBe(403);
      expect((await clearLogo(who)).status).toBe(403);
    }
    expect(await counts()).toEqual(before);
  });

  it("is refused while read-only, leaving nothing stored", async () => {
    const before = store.objects.size;
    const response = await uploadLogo(logoRequest("expired", png()));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "company_read_only" });
    expect((await clearLogo("expired")).status).toBe(403);
    expect(store.objects.size).toBe(before);
  });

  it("removes the object when saving fails", async () => {
    const before = await counts();
    const failing = logoHandlers({
      ...deps,
      db: () =>
        new Proxy(db, {
          get: (target, key) =>
            key === "$transaction"
              ? () => Promise.reject(new Error("database down"))
              : Reflect.get(target, key),
        }),
    });
    const response = await uploadLogo(logoRequest("owner", png()), failing);
    expect(response.status).toBe(500);
    expect(await counts()).toEqual(before);
  });

  it("queues the object for deletion when removing it also fails", async () => {
    const stuck = new MemoryStore();
    stuck.delete = () => Promise.reject(new Error("storage down"));
    const failing = logoHandlers({
      ...deps,
      store: () => stuck,
      db: () =>
        new Proxy(db, {
          get: (target, key) =>
            key === "$transaction"
              ? () => Promise.reject(new Error("database down"))
              : Reflect.get(target, key),
        }),
    });
    const response = await uploadLogo(logoRequest("owner", png()), failing);
    expect(response.status).toBe(500);
    const objectKey = [...stuck.objects.keys()][0]!;
    expect(
      await db.documentDeleteRetry.count({ where: { companyId, objectKey } }),
    ).toBe(1);
    await db.documentDeleteRetry.deleteMany({ where: { objectKey } });
  });

  it("answers 503 and stores nothing without file storage", async () => {
    const before = await counts();
    const noStore = logoHandlers({ ...deps, store: () => null });
    const response = await uploadLogo(logoRequest("owner", png()), noStore);
    expect(response.status).toBe(503);
    expect(await counts()).toEqual(before);
  });
});

describe("replacing and removing the logo (#227)", () => {
  it("keeps old logos, even through documents:cleanup", async () => {
    const first = (await (
      await uploadLogo(logoRequest("owner", png({ width: 2, height: 2 })))
    ).json()) as { id: string };
    const second = (await (
      await uploadLogo(logoRequest("owner", png({ width: 3, height: 3 })))
    ).json()) as { id: string };
    expect(second.id).not.toBe(first.id);
    const old = await db.document.findUniqueOrThrow({
      where: { id: first.id },
    });
    expect(store.objects.has(old.objectKey)).toBe(true);
    expect((await counts()).logo).toBe(second.id);

    const future = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
    await cleanUnattachedDocuments(db, store, { now: future });
    expect(await db.document.count({ where: { id: first.id } })).toBe(1);
    expect(store.objects.has(old.objectKey)).toBe(true);
  });

  it("clears only the reference, and doing it twice changes nothing", async () => {
    const { logo } = await counts();
    expect(logo).not.toBeNull();
    const row = await db.document.findUniqueOrThrow({ where: { id: logo! } });
    const audits = () =>
      db.auditEvent.count({
        where: { companyId, action: "company.logo_changed" },
      });
    const before = await audits();
    expect((await clearLogo("owner")).status).toBe(204);
    expect((await counts()).logo).toBeNull();
    expect(store.objects.has(row.objectKey)).toBe(true);
    expect(await db.document.count({ where: { id: row.id } })).toBe(1);
    expect(await audits()).toBe(before + 1);

    expect((await clearLogo("owner")).status).toBe(204);
    expect(await audits()).toBe(before + 1);
  });
});

describe("logo link (#227)", () => {
  it("is a 404 when the company has no logo", async () => {
    await clearLogo("owner");
    expect((await logoLink("owner")).status).toBe(404);
  });

  it("gives every member a short-lived link to their own logo", async () => {
    const uploaded = await uploadLogo(logoRequest("owner", png()));
    const { id } = (await uploaded.json()) as { id: string };
    for (const who of ["owner", "accountant", "worker"] as const) {
      const response = await logoLink(who);
      expect(response.status).toBe(200);
      const { url, expiresAt } = (await response.json()) as {
        url: string;
        expiresAt: string;
      };
      expect(new Date(expiresAt).getTime()).toBeLessThanOrEqual(
        Date.now() + 5 * 60 * 1000 + 1000,
      );
      const file = await fetchFile(url);
      expect(file.status).toBe(200);
      expect(file.headers.get("content-type")).toBe("image/png");
      expect(file.headers.get("content-security-policy")).toContain("sandbox");
      expect(Buffer.from(await file.arrayBuffer()).equals(png())).toBe(true);
    }
    expect((await counts()).logo).toBe(id);
  });

  it("never reaches another company's logo", async () => {
    const { logo } = await counts();
    // The outsider's company has no logo, so its link is a 404, and asking for
    // the other company's document directly is a 404 too.
    expect((await logoLink("outsider")).status).toBe(404);
    const response = await withPolicy<{ params: Promise<{ id: string }> }>(
      "document.upload",
      documents.link,
    )(send("outsider", "POST", `/api/documents/${logo}/link`), {
      params: Promise.resolve({ id: logo! }),
    });
    expect(response.status).toBe(404);
  });

  it("still works while read-only", async () => {
    await db.company.update({
      where: { id: companyId },
      data: {
        isDemo: false,
        accessMode: "trial",
        trialStartedAt: new Date("2019-12-01T00:00:00Z"),
        trialLastDay: new Date("2020-01-01T00:00:00Z"),
      },
    });
    try {
      expect((await logoLink("owner")).status).toBe(200);
    } finally {
      await db.company.update({
        where: { id: companyId },
        data: { accessMode: "unrestricted", trialLastDay: null },
      });
    }
  });
});

describe("logo malware scanning (#136)", () => {
  let clamd: FakeClamd;
  beforeAll(async () => {
    clamd = await startFakeClamd();
  });
  afterAll(() => clamd.close());

  const scanned = (required: boolean, own = new MemoryStore()) => ({
    own,
    handlers: logoHandlers({
      ...deps,
      store: () => own,
      scanner: () => ({
        required,
        disabled: false,
        scanner: clamdScanner({
          host: "127.0.0.1",
          port: clamd.port,
          idleMs: 500,
          maxConcurrent: 1,
          slotWaitMs: 200,
        }),
      }),
    }),
  });

  it("stores a clean logo", async () => {
    clamd.mode = "normal";
    const { own, handlers } = scanned(true);
    const response = await uploadLogo(logoRequest("owner", png()), handlers);
    expect(response.status).toBe(201);
    expect(own.objects.size).toBe(1);
  });

  it("refuses a flagged logo before it's cleaned or stored, and audits it", async () => {
    clamd.mode = "normal";
    const before = await counts();
    const { own, handlers } = scanned(true);
    // The marker sits in a text chunk that cleaning would have removed:
    // the scan sees the bytes as sent.
    const flagged = png(
      {},
      pngChunk("tEXt", Buffer.from(`Comment\0${TEST_MARKER}`)),
    );
    const response = await uploadLogo(logoRequest("owner", flagged), handlers);
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: string }).error).toMatch(
      /flagged as unsafe/,
    );
    expect(own.objects.size).toBe(0);
    expect(await counts()).toEqual(before);
    expect(
      await db.auditEvent.count({
        where: { companyId, action: "document.malware_rejected" },
      }),
    ).toBeGreaterThan(0);
  });

  it("fails closed when the scanner can't answer, or is required but missing", async () => {
    const before = await counts();
    clamd.mode = "error";
    const broken = scanned(true);
    expect(
      (await uploadLogo(logoRequest("owner", png()), broken.handlers)).status,
    ).toBe(503);
    expect(broken.own.objects.size).toBe(0);
    const missing = logoHandlers({
      ...deps,
      store: () => new MemoryStore(),
      scanner: () => ({ required: true, scanner: null, disabled: false }),
    });
    expect(
      (await uploadLogo(logoRequest("owner", png()), missing)).status,
    ).toBe(503);
    expect(await counts()).toEqual(before);
    clamd.mode = "normal";
  });
});
