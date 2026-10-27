import { afterEach, expect, it, vi } from "vitest";
import { GET } from "../../apps/web/src/app/api/health/route";
import { GET as ready } from "../../apps/web/src/app/api/health/ready/route";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it("returns minimal non-cacheable liveness without private configuration", async () => {
  const response = GET();
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.json()).toEqual({
    status: "ok",
    service: "jobflow-web",
  });
});

const NO_STORAGE = {
  S3_ACCESS_KEY_ID: "",
  S3_SECRET_ACCESS_KEY: "",
  MINIO_ROOT_USER: "",
  MINIO_ROOT_PASSWORD: "",
};

it("is ready only when the database answers and storage is configured (#64)", async () => {
  const clock = vi.spyOn(Date, "now");
  clock.mockReturnValue(0);
  for (const [name, value] of Object.entries(NO_STORAGE)) {
    vi.stubEnv(name, value);
  }
  const notReady = await ready();
  expect(notReady.status).toBe(503);
  expect(notReady.headers.get("Cache-Control")).toBe("no-store");
  // Never says which part is missing.
  expect(await notReady.json()).toEqual({
    status: "not ready",
    service: "jobflow-web",
  });

  vi.stubEnv("S3_ACCESS_KEY_ID", "synthetic-key-id");
  vi.stubEnv("S3_SECRET_ACCESS_KEY", "synthetic-secret");
  vi.stubEnv("S3_BUCKET", "jobflow-ready-test");
  // The server probes again after its two-second internal cache expires.
  clock.mockReturnValue(2001);
  const response = await ready();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    status: "ready",
    service: "jobflow-web",
  });
  clock.mockRestore();
});
