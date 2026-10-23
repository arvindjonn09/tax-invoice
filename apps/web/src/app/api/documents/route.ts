import { withPolicy } from "@/server/authz";
import {
  UPLOAD_BODY_LIMIT,
  documentHandlers,
} from "@/server/documents/handlers";
import { documentDeps } from "@/server/documents";

export const dynamic = "force-dynamic";

const handlers = documentHandlers(documentDeps);

/** Upload one file (multipart: file, kind). Type is checked from its bytes. */
export const POST = withPolicy("document.upload", handlers.upload, {
  maxBodyBytes: UPLOAD_BODY_LIMIT,
});
