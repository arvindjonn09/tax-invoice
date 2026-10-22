/** Liveness only. Does not expose configuration or imply database readiness. */
export function GET() {
  return Response.json(
    { status: "ok", service: "jobflow-web" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
