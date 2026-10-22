import { expect, it } from "vitest";
import { GET } from "../../apps/web/src/app/api/health/route";
it("returns minimal non-cacheable liveness without private configuration", async () => {
  const response = GET();
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.json()).toEqual({
    status: "ok",
    service: "jobflow-web",
  });
});
