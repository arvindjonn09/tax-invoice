import { withPolicy } from "@/server/authz";
import { LOGO_BODY_LIMIT, logoHandlers } from "@/server/company/logo";
import { documentDeps } from "@/server/documents";

export const dynamic = "force-dynamic";

const handlers = logoHandlers(documentDeps);

/** Upload or replace the logo (multipart: file). PNG or JPEG, metadata removed. */
export const POST = withPolicy("company.update", handlers.upload, {
  maxBodyBytes: LOGO_BODY_LIMIT,
});
/** Stop showing the logo. The stored document stays. */
export const DELETE = withPolicy("company.update", handlers.remove);
