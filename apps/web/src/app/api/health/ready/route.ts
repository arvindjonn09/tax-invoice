import { getDatabase } from "../../../../server/auth";
import { storeFromEnvironment } from "../../../../server/documents/store";

export const dynamic = "force-dynamic";

/**
 * Readiness (#64): the database answers and document storage is configured.
 * Says only ready / not ready — never which part failed or how it is set up,
 * so the probe can be public behind the proxy.
 */
export async function GET() {
  let ready = storeFromEnvironment() !== null;
  if (ready) {
    try {
      await getDatabase().$queryRaw`SELECT 1`;
    } catch {
      ready = false;
    }
  }
  return Response.json(
    { status: ready ? "ready" : "not ready", service: "jobflow-web" },
    { status: ready ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
