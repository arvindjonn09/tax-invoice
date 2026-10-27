import { getDatabase } from "../../../../server/auth";
import { storeFromEnvironment } from "../../../../server/documents/store";
import { cachedReadiness } from "../../../../server/health/readiness";

export const dynamic = "force-dynamic";

/**
 * Readiness (#64): the database answers and document storage is configured.
 * Says only ready / not ready — never which part failed or how it is set up,
 * so the probe can be public behind the proxy.
 */
const TIMEOUT_MS = 3000;

const probe = cachedReadiness(async () => {
  let ready = storeFromEnvironment() !== null;
  if (ready) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // A stalled database is "not ready" within 3 s, not a hung probe.
      await Promise.race([
        getDatabase().$queryRaw`SELECT 1`,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS);
        }),
      ]);
    } catch {
      ready = false;
    } finally {
      clearTimeout(timer);
    }
  }
  return ready;
});

export async function GET() {
  const ready = await probe();
  return Response.json(
    { status: ready ? "ready" : "not ready", service: "jobflow-web" },
    { status: ready ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
