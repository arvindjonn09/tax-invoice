import { withPolicy } from "@/server/authz";
import { documentHandlers } from "@/server/documents/handlers";
import { documentDeps } from "@/server/documents";

export const dynamic = "force-dynamic";

const handlers = documentHandlers(documentDeps);

/** A 5-minute download link, only for documents this user may see. */
export const POST = withPolicy("document.upload", handlers.link);
