import { randomBytes, randomUUID } from "node:crypto";
import { requireOwnCompany } from "@jobflow/authz";
import { withAudit } from "../../../../../packages/database/src/index";
import { type PolicyHandler, privateJson } from "../authz/policy";
import {
  LINK_TTL_SECONDS,
  safeFileName,
  sha256Hex,
  signLink,
} from "../documents/files";
import { type DocumentDeps, readMultipart } from "../documents/handlers";
import type { ObjectStore } from "../documents/store";
import { clientIp, throttle } from "../http/throttle";
import { log } from "../log";
import { cleanLogo, MAX_LOGO_BYTES, MAX_LOGO_SIDE } from "./logo-image";

// #227 (S6). A logo is a private document like any other, with stricter checks.
// Replacing one never overwrites it: sent quotes and issued invoices keep
// pointing at the logo current when they were sent.

/** Multipart overhead allowed on top of the file itself. */
export const LOGO_BODY_LIMIT = MAX_LOGO_BYTES + 64 * 1024;

const TOO_LARGE = "Logos can be at most 2 MB";
const unavailable = () =>
  privateJson(
    { error: "File storage isn't available right now. Try again later." },
    { status: 503 },
  );

export function logoHandlers(deps: DocumentDeps) {
  /** The object has no row, so nobody can reach it: remove it now or later. */
  async function discard(
    store: ObjectStore,
    objectKey: string,
    companyId: string,
  ): Promise<void> {
    try {
      await store.delete(objectKey);
    } catch {
      await deps
        .db()
        .documentDeleteRetry.create({
          data: { id: randomUUID(), companyId, objectKey },
        })
        .catch((error: unknown) =>
          log("error", "company.logo_cleanup_failed", {
            companyId,
            reason: error instanceof Error ? error.name : "unknown",
          }),
        );
    }
  }

  const upload: PolicyHandler<unknown> = async ({ actor, request }) => {
    const store = deps.store();
    if (!store) return unavailable();
    await throttle(deps.db(), "document.upload", {
      userId: actor.userId,
      ip: clientIp(request.headers),
    });
    const form = await readMultipart(request, LOGO_BODY_LIMIT, TOO_LARGE);
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0)
      return privateJson({ error: "Choose a logo to upload" }, { status: 400 });
    if (file.size > MAX_LOGO_BYTES)
      return privateJson({ error: TOO_LARGE }, { status: 413 });
    const logo = cleanLogo(new Uint8Array(await file.arrayBuffer()));
    if ("refused" in logo)
      return logo.refused === "dimensions"
        ? privateJson(
            {
              error: `Logos can be at most ${MAX_LOGO_SIDE} × ${MAX_LOGO_SIDE} pixels`,
            },
            { status: 422 },
          )
        : privateJson({ error: "Upload a PNG or JPEG file" }, { status: 415 });
    const id = randomUUID();
    const objectKey = `documents/${actor.companyId}/${randomBytes(32).toString("hex")}`;
    await store.put(objectKey, logo.bytes, logo.type);
    try {
      await withAudit(deps.db(), async (tx, audit) => {
        const before = requireOwnCompany(
          actor,
          await tx.company.findUnique({ where: { id: actor.companyId } }),
        );
        await tx.document.create({
          data: {
            id,
            companyId: actor.companyId,
            kind: "company_logo",
            objectKey,
            fileName: safeFileName(file.name, logo.type),
            contentType: logo.type,
            sizeBytes: logo.bytes.byteLength,
            sha256: sha256Hex(logo.bytes),
            createdBy: actor.userId,
          },
        });
        await tx.company.update({
          where: { id: before.id },
          data: { logoDocumentId: id },
        });
        await audit({
          companyId: actor.companyId,
          actorUserId: actor.userId,
          action: "company.logo_changed",
          target: { type: "company", id: before.id },
          before: { logoDocumentId: before.logoDocumentId },
          after: { logoDocumentId: id },
        });
      });
    } catch (error) {
      await discard(store, objectKey, actor.companyId);
      throw error;
    }
    return privateJson(
      {
        id,
        contentType: logo.type,
        sizeBytes: logo.bytes.byteLength,
        width: logo.width,
        height: logo.height,
      },
      { status: 201 },
    );
  };

  /** Clears the reference only: the document stays for anything sent with it. */
  const remove: PolicyHandler<unknown> = async ({ actor }) => {
    const current = requireOwnCompany(
      actor,
      await deps.db().company.findUnique({ where: { id: actor.companyId } }),
    );
    // Every audited transaction must record an event, so a no-op skips it.
    if (current.logoDocumentId)
      await withAudit(deps.db(), async (tx, audit) => {
        const before = requireOwnCompany(
          actor,
          await tx.company.findUnique({ where: { id: actor.companyId } }),
        );
        await tx.company.update({
          where: { id: before.id },
          data: { logoDocumentId: null },
        });
        await audit({
          companyId: actor.companyId,
          actorUserId: actor.userId,
          action: "company.logo_changed",
          target: { type: "company", id: before.id },
          before: { logoDocumentId: before.logoDocumentId },
          after: { logoDocumentId: null },
        });
      });
    return new Response(null, {
      status: 204,
      headers: { "cache-control": "private, no-store" },
    });
  };

  /** A 5-minute link to the actor's own company's logo; 404 when it has none. */
  const link: PolicyHandler<unknown> = async ({ actor, request }) => {
    const company = requireOwnCompany(
      actor,
      await deps.db().company.findUnique({ where: { id: actor.companyId } }),
    );
    if (!company.logoDocumentId)
      return privateJson({ error: "Not found" }, { status: 404 });
    await throttle(deps.db(), "download.sign", {
      userId: actor.userId,
      ip: clientIp(request.headers),
    });
    const exp = Math.floor(Date.now() / 1000) + LINK_TTL_SECONDS;
    const token = signLink(
      { documentId: company.logoDocumentId, companyId: company.id, exp },
      deps.secret(),
    );
    return privateJson({
      url: `/api/files/${token}`,
      expiresAt: new Date(exp * 1000).toISOString(),
    });
  };

  return { upload, remove, link };
}
