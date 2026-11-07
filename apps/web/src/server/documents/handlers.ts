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
import { log } from "../log";
import { type Release, type Scanning, ScannerUnavailable } from "./scanner";
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
  /**
   * #136 malware scanning (scannerFromEnvironment). `required` refuses
   * uploads when no scanner is configured or it can't give a clear answer.
   * Required, so no caller can forget it.
   */
  scanner: () => Scanning;
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
export async function readMultipart(
  request: Request,
  limit: number,
  tooLarge = "Files can be at most 10 MB",
) {
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
      throw new HttpError(413, tooLarge);
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
const scanUnavailable = () =>
  privateJson(
    {
      error:
        "File checking isn't available right now, so the file wasn't saved. Try again in a few minutes.",
    },
    { status: 503 },
  );

/** clamd reports a password-protected file as Heuristics.Encrypted.*. */
const UNSCANNABLE_MESSAGE = {
  encrypted:
    "This file is password-protected, so it couldn't be checked for malware and wasn't saved. Upload a copy without a password.",
  limits:
    "This file is too large or complex to check for malware, so it wasn't saved. Try a smaller copy, or save it as a new PDF and upload that.",
} as const;
const unscannable = (detection: string) =>
  privateJson(
    {
      error: /^Heuristics\.Encrypted/.test(detection)
        ? UNSCANNABLE_MESSAGE.encrypted
        : UNSCANNABLE_MESSAGE.limits,
    },
    { status: 422 },
  );

let disabledLogged = false;

/** How long an upload body may take to arrive once a scan slot is held. */
export const BODY_DEADLINE_MS = 30_000;

/** Reject with 503 when `work` doesn't settle in time. */
export async function withDeadline<T>(
  work: Promise<T>,
  ms: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new HttpError(503, "The upload took too long. Try again.")),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** A scan slot, or the 503 to send when scanning is required but can't run. */
export async function reserveScan(
  deps: Pick<DocumentDeps, "scanner">,
): Promise<Response | { scanning: Scanning; release: Release | undefined }> {
  const scanning = deps.scanner();
  if (scanning.disabled && !disabledLogged) {
    disabledLogged = true;
    log("warn", "document.scan_disabled", { reason: "MALWARE_SCAN=off" });
  }
  if (!scanning.scanner && scanning.required) {
    log("error", "document.scan_unavailable", { reason: "not configured" });
    return scanUnavailable();
  }
  let release: Release | undefined;
  if (scanning.scanner) {
    try {
      release = await scanning.scanner.reserve();
    } catch (error) {
      log("error", "document.scan_unavailable", {
        reason: error instanceof ScannerUnavailable ? error.reason : "unknown",
      });
      return scanUnavailable();
    }
  }
  return { scanning, release };
}

/**
 * Scan `bytes` before anything is stored (#136). Returns the refusal to send
 * (infected, unscannable, scanner unavailable), or null when it's clean or
 * scanning is off. Releases the slot once clamd has answered.
 */
export async function scanOrRefuse(
  deps: Pick<DocumentDeps, "db">,
  actor: { companyId: string; userId: string },
  scanning: Scanning,
  bytes: Uint8Array,
  type: string,
  releaseSlot: () => void,
): Promise<Response | null> {
  if (!scanning.scanner) return null;
  let result;
  try {
    result = await scanning.scanner.scan(bytes);
  } catch (error) {
    releaseSlot();
    log("error", "document.scan_unavailable", {
      reason: error instanceof ScannerUnavailable ? error.reason : "unknown",
    });
    return scanUnavailable();
  }
  // The slot is for clamd only; storing and the database don't need it.
  releaseSlot();
  if (result.status === "clean") return null;
  // No file name or contents: only who, and what clamd reported. Logs
  // rotate, so the audit trail keeps it too.
  log("warn", "document.malware_rejected", {
    companyId: actor.companyId,
    userId: actor.userId,
    outcome: result.status,
    detection: result.detection,
  });
  await withAudit(deps.db(), async (_tx, audit) => {
    await audit({
      companyId: actor.companyId,
      actorUserId: actor.userId,
      action: "document.malware_rejected",
      target: { type: "document_upload", id: randomUUID() },
      after: {
        outcome: result.status,
        detection: result.detection,
        contentType: type,
        sizeBytes: bytes.byteLength,
      },
    });
  });
  return result.status === "infected"
    ? privateJson(
        {
          error:
            "This file can't be accepted because it was flagged as unsafe. Upload a different copy.",
        },
        { status: 422 },
      )
    : unscannable(result.detection);
}

export function documentHandlers(deps: DocumentDeps) {
  const upload: PolicyHandler<unknown> = async (context) => {
    const store = deps.store();
    if (!store) return unavailable();
    // Per user and per IP, before reading a single byte of the body.
    await throttle(deps.db(), "document.upload", {
      userId: context.actor.userId,
      ip: clientIp(context.request.headers),
    });
    // #136: scanning setup, and a scan slot, before the body is read.
    const slot = await reserveScan(deps);
    if (slot instanceof Response) return slot;
    const { scanning, release } = slot;
    try {
      return await receive(context, store, scanning, () => release?.());
    } finally {
      release?.();
    }
  };

  const receive = async (
    { actor, request }: Parameters<PolicyHandler<unknown>>[0],
    store: ObjectStore,
    scanning: Scanning,
    releaseSlot: () => void,
  ) => {
    // The scan slot is held from before the body is read, so a stalled
    // upload can't hold it for ever: the body has a deadline of its own.
    const form = await withDeadline(
      readMultipart(request, UPLOAD_BODY_LIMIT),
      BODY_DEADLINE_MS,
    );
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
    // #136: scan before anything is stored; fail closed when required.
    const refused = await scanOrRefuse(
      deps,
      actor,
      scanning,
      bytes,
      type,
      releaseSlot,
    );
    if (refused) return refused;
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
export function downloadHandler(deps: Omit<DocumentDeps, "scanner">) {
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
