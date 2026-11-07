import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { dispatchSoon, emailSecret } from "@/server/email";
import { extensionRequestHandlers } from "@/server/trial/extension-requests";

export const dynamic = "force-dynamic";

const handlers = extensionRequestHandlers({
  db: getDatabase,
  emailSecret,
  appUrl: () => new URL(process.env.BETTER_AUTH_URL ?? "").origin,
  operatorEmail: () => process.env.OPERATOR_NOTIFY_EMAIL?.trim() || null,
  dispatch: dispatchSoon,
});

/** Current pending request and the last 10 decisions (S14). */
export const GET = withPolicy("trial.request_extension", handlers.list);
/** An owner asks for more time; allowed while read-only (READ_ONLY_ALLOWED). */
export const POST = withPolicy("trial.request_extension", handlers.create);
