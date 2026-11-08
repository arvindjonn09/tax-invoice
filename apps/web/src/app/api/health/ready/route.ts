import { getDatabase, isProductionEnvironment } from "../../../../server/auth";
import { scannerFromEnvironment } from "../../../../server/documents/scanner";
import { storeFromEnvironment } from "../../../../server/documents/store";
import { cachedReadiness } from "../../../../server/health/readiness";

export const dynamic = "force-dynamic";

/**
 * Readiness (#64): the database answers, document storage is configured,
 * in production extension requests have somewhere to go (#231), and where
 * malware scanning is required (#136) clamd answers PING, so a deploy can't
 * report success while every upload would get a 503.
 * Says only ready / not ready — never which part failed or how it is set up,
 * so the probe can be public behind the proxy.
 */
const TIMEOUT_MS = 3000;

const probe = cachedReadiness(async () => {
  let ready =
    storeFromEnvironment() !== null &&
    // Owners are told "we'll email you", so someone has to receive requests.
    (!isProductionEnvironment(process.env) ||
      Boolean(process.env.OPERATOR_NOTIFY_EMAIL));
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
  if (ready) {
    const scanning = scannerFromEnvironment();
    if (scanning.required)
      ready = scanning.scanner !== null && (await scanning.scanner.ping());
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
