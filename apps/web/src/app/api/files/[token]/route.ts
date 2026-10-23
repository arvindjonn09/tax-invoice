import { downloadHandler } from "@/server/documents/handlers";
import { documentDeps } from "@/server/documents";

// Public exception (route-policy.test.ts): the signed, unexpired token minted
// after an authorisation check is the permission. Always a download.
export const dynamic = "force-dynamic";

export const GET = downloadHandler(documentDeps);
