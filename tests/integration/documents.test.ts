import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../packages/database/src/generated/prisma/client";
import { createAuth } from "../../apps/web/src/server/auth/config";
import { createCredentialUser } from "../../apps/web/src/server/auth/credentials";
import { createWithPolicy } from "../../apps/web/src/server/authz/policy";
import { signLink } from "../../apps/web/src/server/documents/files";
import {
  UPLOAD_BODY_LIMIT,
  documentHandlers,
  downloadHandler,
} from "../../apps/web/src/server/documents/handlers";
import {
  MemoryStore,
  S3Store,
  storeFromEnvironment,
} from "../../apps/web/src/server/documents/store";
import {
  type CommittedDatabase,
  withCommittedDatabase,
} from "../helpers/committed-database";
import { syntheticFactory } from "../helpers/factories";

// #34: private storage — type/size allow-list, random keys, links only after
// authz, expired or forged links fail, other companies never get a URL.
const ORIGIN = "http://127.0.0.1:3000";
const PASSWORD = "correct horse battery staple";
type Who = "owner" | "accountant" | "worker" | "colleague" | "outsider";
const WHO: readonly Who[] = [
  "owner",
  "accountant",
  "worker",
  "colleague",
  "outsider",
];

const SECRET = randomBytes(32).toString("hex");
const PDF = new Uint8Array(Buffer.from("%PDF-1.7\nsynthetic receipt\n%%EOF\n"));
let database: CommittedDatabase;
let db: PrismaClient;
let withPolicy: ReturnType<typeof createWithPolicy>;
const store = new MemoryStore();
const deps = { db: () => db, store: () => store, secret: () => SECRET };
const handlers = documentHandlers(deps);
const download = downloadHandler(deps);
const userIds = {} as Record<Who, string>;
const cookies = {} as Record<Who, Headers>;
let companyId = "";
const factory = syntheticFactory(0x3434);

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
  const own = factory.company(userIds.owner);
  const other = factory.company(userIds.outsider);
  for (const [record, owner] of [
    [own, userIds.owner],
    [other, userIds.outsider],
  ] as const) {
    await db.$transaction(async (tx) => {
      await tx.company.create({ data: record });
      await tx.membership.create({
        data: factory.membership(record.id, owner),
      });
    });
  }
  companyId = own.id;
  for (const [key, role] of [
    ["accountant", "accountant"],
    ["worker", "employee"],
    ["colleague", "employee"],
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

function uploadRequest(
  who: Who,
  file: Uint8Array | null,
  { name = "receipt.pdf", kind = "receipt" } = {},
): Request {
  const form = new FormData();
  if (file) form.set("file", new File([Buffer.from(file)], name));
  form.set("kind", kind);
  const headers = new Headers(cookies[who]);
  headers.set("origin", ORIGIN);
  return new Request(`${ORIGIN}/api/documents`, {
    method: "POST",
    headers,
    body: form,
  });
}
const upload = (request: Request) =>
  withPolicy("document.upload", handlers.upload, {
    maxBodyBytes: UPLOAD_BODY_LIMIT,
  })(request, undefined);
function linkFor(who: Who, id: string) {
  const headers = new Headers(cookies[who]);
  headers.set("origin", ORIGIN);
  return withPolicy("document.upload", handlers.link)(
    new Request(`${ORIGIN}/api/documents/${id}/link`, {
      method: "POST",
      headers,
    }),
    { params: Promise.resolve({ id }) },
  );
}
const fetchFile = (url: string) =>
  download(new Request(`${ORIGIN}${url}`), {
    params: Promise.resolve({ token: url.replace("/api/files/", "") }),
  });

describe("uploads", () => {
  let workerDoc = "";

  it("stores an employee's receipt under a random key, audited, without user paths", async () => {
    const response = await upload(
      uploadRequest("worker", PDF, { name: "../../secret/Receipt.exe" }),
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    workerDoc = body.id;
    expect(body).toMatchObject({
      kind: "receipt",
      fileName: "Receipt.pdf",
      contentType: "application/pdf",
      sizeBytes: PDF.byteLength,
    });
    const row = await db.document.findUniqueOrThrow({
      where: { id: workerDoc },
    });
    expect(row.objectKey).toMatch(
      new RegExp(`^documents/${companyId}/[0-9a-f]{64}$`),
    );
    expect(row.objectKey).not.toContain("secret");
    expect(store.objects.get(row.objectKey)).toEqual(PDF);
    expect(
      await db.auditEvent.count({
        where: { companyId, action: "document.uploaded", targetId: workerDoc },
      }),
    ).toBe(1);
  });

  it("rejects disallowed types (by content, not name), oversized, empty and non-multipart uploads", async () => {
    const html = new Uint8Array(Buffer.from("<html><script>alert(1)</script>"));
    expect(
      (await upload(uploadRequest("worker", html, { name: "fake.pdf" })))
        .status,
    ).toBe(415);
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set(PDF);
    expect((await upload(uploadRequest("worker", big))).status).toBe(413);
    expect(
      (await upload(uploadRequest("worker", new Uint8Array()))).status,
    ).toBe(400);
    expect(
      (await upload(uploadRequest("worker", PDF, { kind: "virus" }))).status,
    ).toBe(400);
    const headers = new Headers(cookies.worker);
    headers.set("origin", ORIGIN);
    headers.set("content-type", "application/json");
    expect(
      (
        await upload(
          new Request(`${ORIGIN}/api/documents`, {
            method: "POST",
            headers,
            body: "{}",
          }),
        )
      ).status,
    ).toBe(415);
    expect(store.objects.size).toBe(1);
  });

  it("gives links only to people who may see the document", async () => {
    // The uploader and office roles can; a colleague and another company can't.
    for (const who of ["worker", "owner", "accountant"] as const)
      expect((await linkFor(who, workerDoc)).status, who).toBe(200);
    for (const who of ["colleague", "outsider"] as const)
      expect((await linkFor(who, workerDoc)).status, who).toBe(404);
    expect(
      (await linkFor("owner", "00000000-0000-4000-8000-000000000000")).status,
    ).toBe(404);
    expect((await linkFor("owner", "not-a-uuid")).status).toBe(404);
  });

  it("serves a fresh link as a sandboxed private attachment", async () => {
    const { url, expiresAt } = await (await linkFor("owner", workerDoc)).json();
    expect(new Date(expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(
      5 * 60 * 1000,
    );
    const response = await fetchFile(url);
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PDF);
    expect(Object.fromEntries(response.headers)).toMatchObject({
      "content-type": "application/pdf",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    });
    expect(response.headers.get("content-disposition")).toMatch(
      /^attachment; filename="Receipt.pdf"/,
    );
  });

  it("refuses expired, forged and cross-company links", async () => {
    const past = Math.floor(Date.now() / 1000) - 1;
    const expired = signLink(
      { documentId: workerDoc, companyId, exp: past },
      SECRET,
    );
    expect((await fetchFile(`/api/files/${expired}`)).status).toBe(410);
    const wrongKey = signLink(
      { documentId: workerDoc, companyId, exp: past + 600 },
      randomBytes(32).toString("hex"),
    );
    expect((await fetchFile(`/api/files/${wrongKey}`)).status).toBe(404);
    // A validly signed token naming another company never finds the file.
    const otherCompany = (
      await db.membership.findFirstOrThrow({
        where: { userId: userIds.outsider },
      })
    ).companyId;
    const crossed = signLink(
      { documentId: workerDoc, companyId: otherCompany, exp: past + 600 },
      SECRET,
    );
    expect((await fetchFile(`/api/files/${crossed}`)).status).toBe(404);
  });

  it("reports storage as unavailable instead of failing open", async () => {
    const offline = documentHandlers({ ...deps, store: () => null });
    const response = await withPolicy("document.upload", offline.upload, {
      maxBodyBytes: UPLOAD_BODY_LIMIT,
    })(uploadRequest("owner", PDF), undefined);
    expect(response.status).toBe(503);
  });
});

// Real S3-compatible storage: runs where MinIO is up (CI's docker compose).
const s3 = storeFromEnvironment();
describe.runIf(s3 instanceof S3Store && process.env.CI)(
  "S3 storage (MinIO)",
  () => {
    it("round-trips an object privately and reports a missing key as null", async () => {
      const key = `documents/test/${randomBytes(32).toString("hex")}`;
      await s3!.put(key, PDF, "application/pdf");
      expect(await s3!.get(key)).toEqual(PDF);
      expect(await s3!.get(`${key}-missing`)).toBeNull();
    });
  },
);
