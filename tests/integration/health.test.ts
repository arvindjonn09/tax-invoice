import { afterEach, expect, it, vi } from "vitest";
import { startFakeClamd } from "../helpers/fake-clamd";
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

  // #136: where scanning is required, clamd must answer PING too.
  vi.stubEnv("APP_ENV", "staging");
  vi.stubEnv("CLAMAV_HOST", "");
  clock.mockReturnValue(4002);
  expect((await ready()).status).toBe(503);
  const clamd = await startFakeClamd();
  try {
    vi.stubEnv("CLAMAV_HOST", "127.0.0.1");
    vi.stubEnv("CLAMAV_PORT", String(clamd.port));
    clamd.mode = "silent";
    clock.mockReturnValue(6003);
    expect((await ready()).status).toBe(503);
    clamd.mode = "normal";
    clock.mockReturnValue(8004);
    expect((await ready()).status).toBe(200);
  } finally {
    await clamd.close();
  }
  clock.mockRestore();
});

it("in production, needs someone to receive extension requests (#323)", async () => {
  const clock = vi.spyOn(Date, "now");
  clock.mockReturnValue(1_000_000);
  vi.stubEnv("APP_ENV", "production");
  vi.stubEnv("S3_ACCESS_KEY_ID", "synthetic-key-id");
  vi.stubEnv("S3_SECRET_ACCESS_KEY", "synthetic-secret");
  vi.stubEnv("S3_BUCKET", "jobflow-ready-test");
  vi.stubEnv("OPERATOR_NOTIFY_EMAIL", "");
  const notReady = await ready();
  expect(notReady.status).toBe(503);
  expect(await notReady.json()).toEqual({
    status: "not ready",
    service: "jobflow-web",
  });
  vi.stubEnv("OPERATOR_NOTIFY_EMAIL", "operator@jobflow.invalid");
  clock.mockReturnValue(1_002_001);
  expect((await ready()).status).toBe(200);
  clock.mockRestore();
});
