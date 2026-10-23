import { randomBytes, randomUUID } from "node:crypto";
import { can, requireSameCompany } from "@jobflow/authz";
import { z } from "zod";
import type {
  Document,
  PrismaClient,
} from "../../../../../packages/database/src/generated/prisma/client";
import { withAudit } from "../../../../../packages/database/src/index";
import { type PolicyHandler, privateJson } from "../authz/policy";
import { uuidOrNull } from "../http/fields";
import { HttpError } from "../http/guards";
import { clientIp, throttle } from "../http/throttle";
import {
  LINK_TTL_SECONDS,
  MAX_DOCUMENT_BYTES,
  safeFileName,
  sha256Hex,
  signLink,
  sniffType,
  verifyLink,
} from "./files";
import type { ObjectStore } from "./store";

// #34. Upload through the app (so the server checks the real bytes), store
// privately under a random key, and hand out only short-lived signed links
// after an authorisation check. Office roles (document.read_all) may link any
// company document; everyone else only the documents they uploaded.

export type DocumentDeps = {
  db: () => PrismaClient;
  store: () => ObjectStore | null;
  /** App secret (BETTER_AUTH_SECRET); a link key is derived from it. */
  secret: () => string;
};

/** Multipart overhead allowed on top of the file itself. */
export const UPLOAD_BODY_LIMIT = MAX_DOCUMENT_BYTES + 64 * 1024;

const Kind = z.enum(["receipt", "photo", "tax_invoice", "other"]);

function documentView(row: Document) {
  return {
    id: row.id,
    kind: row.kind,
    fileName: row.fileName,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt,
  };
}

/** Read at most `limit` bytes of the body, then parse it as multipart. */
async function readMultipart(request: Request, limit: number) {
  const type = request.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data;/i.test(type))
    throw new HttpError(415, "Upload a file as multipart/form-data");
  if (!request.body) throw new HttpError(400, "Choose a file to upload");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new HttpError(413, "Files can be at most 10 MB");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return await new Response(body, {
      headers: { "content-type": type },
    }).formData();
  } catch {
    throw new HttpError(400, "Couldn't read the upload");
  }
}

const unavailable = () =>
  privateJson(
    { error: "File storage isn't available right now. Try again later." },
    { status: 503 },
  );

export function documentHandlers(deps: DocumentDeps) {
  const upload: PolicyHandler<unknown> = async ({ actor, request }) => {
    const store = deps.store();
    if (!store) return unavailable();
    // Per user and per IP, before reading a single byte of the body.
    await throttle(deps.db(), "document.upload", {
      userId: actor.userId,
      ip: clientIp(request.headers),
    });
    const form = await readMultipart(request, UPLOAD_BODY_LIMIT);
    const file = form.get("file");
    const kind = Kind.safeParse(form.get("kind"));
    if (!(file instanceof File))
      return privateJson({ error: "Choose a file to upload" }, { status: 400 });
    if (!kind.success)
      return privateJson({ error: "Choose a document type" }, { status: 400 });
    if (file.size === 0)
      return privateJson({ error: "The file is empty" }, { status: 400 });
    if (file.size > MAX_DOCUMENT_BYTES)
      return privateJson(
        { error: "Files can be at most 10 MB" },
        { status: 413 },
      );
    const bytes = new Uint8Array(await file.arrayBuffer());
    const type = sniffType(bytes);
    if (!type)
      return privateJson(
        { error: "Upload a PDF, JPEG, PNG, WebP or HEIC file" },
        { status: 415 },
      );
    const id = randomUUID();
    // Random key, never derived from the file name or any user input.
    const objectKey = `documents/${actor.companyId}/${randomBytes(32).toString("hex")}`;
    await store.put(objectKey, bytes, type);
    let row: Document;
    try {
      row = await withAudit(deps.db(), async (tx, audit) => {
        const created = await tx.document.create({
          data: {
            id,
            companyId: actor.companyId,
            kind: kind.data,
            objectKey,
            fileName: safeFileName(file.name, type),
            contentType: type,
            sizeBytes: bytes.byteLength,
            sha256: sha256Hex(bytes),
            createdBy: actor.userId,
          },
        });
        await audit({
          companyId: actor.companyId,
          actorUserId: actor.userId,
          action: "document.uploaded",
          target: { type: "document", id },
          after: {
            kind: created.kind,
            contentType: type,
            sizeBytes: created.sizeBytes,
          },
        });
        return created;
      });
    } catch (error) {
      // No row means nobody can ever reach the object: remove it, then fail.
      await store.delete(objectKey).catch(() => undefined);
      throw error;
    }
    return privateJson(documentView(row), { status: 201 });
  };

  /**
   * A 5-minute download link, after checking the actor may see this document.
   * Another company's document, or someone else's without document.read_all,
   * is a 404 — never a link.
   */
  const link: PolicyHandler<{ params: Promise<{ id: string }> }> = async ({
    actor,
    request,
    context,
  }) => {
    const id = uuidOrNull((await context.params).id);
    const row = requireSameCompany(
      actor,
      id ? await deps.db().document.findUnique({ where: { id } }) : null,
    );
    if (row.createdBy !== actor.userId && !can(actor.role, "document.read_all"))
      requireSameCompany(actor, null);
    await throttle(deps.db(), "download.sign", {
      userId: actor.userId,
      ip: clientIp(request.headers),
    });
    const exp = Math.floor(Date.now() / 1000) + LINK_TTL_SECONDS;
    const token = signLink(
      { documentId: row.id, companyId: row.companyId, exp },
      deps.secret(),
    );
    return privateJson({
      url: `/api/files/${token}`,
      expiresAt: new Date(exp * 1000).toISOString(),
    });
  };

  return { upload, link };
}

/**
 * Public route (explicit exception in route-policy.test.ts): the signed,
 * unexpired token is the authorisation, minted by `link` after authz. The file
 * is always a download with a sandboxing CSP, so it can never run as a page in
 * the app's origin.
 */
export function downloadHandler(deps: DocumentDeps) {
  return async (
    _request: Request,
    context: { params: Promise<{ token: string }> },
  ): Promise<Response> => {
    const { token } = await context.params;
    const check = verifyLink(token, deps.secret());
    if (!check.ok)
      return privateJson(
        {
          error:
            check.reason === "expired"
              ? "This download link has expired. Get a new one from the app."
              : "Not found",
        },
        { status: check.reason === "expired" ? 410 : 404 },
      );
    const { documentId, companyId } = check.claims;
    const row = await deps.db().document.findFirst({
      where: { id: documentId, companyId },
    });
    const store = deps.store();
    if (!row || !store)
      return privateJson({ error: "Not found" }, { status: 404 });
    const bytes = await store.get(row.objectKey);
    if (!bytes) return privateJson({ error: "Not found" }, { status: 404 });
    return new Response(Buffer.from(bytes), {
      headers: {
        "content-type": row.contentType,
        "content-length": String(bytes.byteLength),
        "content-disposition": `attachment; filename="${row.fileName.replace(/[^\x20-\x7e]|"/g, "_")}"; filename*=UTF-8''${encodeURIComponent(row.fileName)}`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
        "referrer-policy": "no-referrer",
        "cross-origin-resource-policy": "same-origin",
      },
    });
  };
}
