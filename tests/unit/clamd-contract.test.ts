import { describe, expect, it } from "vitest";
import {
  ScannerUnavailable,
  clamdScanner,
} from "../../apps/web/src/server/documents/scanner";
import { EICAR } from "../helpers/fake-clamd";

// #136: the scanner client against a REAL clamd (the pinned image, run by the
// `clamav-contract` CI job with infra/staging/clamav/clamd.conf). Skipped
// unless CLAMD_CONTRACT_HOST is set, so ordinary test runs never need Docker.
const host = process.env.CLAMD_CONTRACT_HOST;
const scanner = () =>
  clamdScanner({
    host: host!,
    port: Number(process.env.CLAMD_CONTRACT_PORT ?? "3310"),
    idleMs: 30_000,
    deadlineMs: 45_000,
  });
const pdf = (body: string) =>
  new Uint8Array(
    Buffer.from(
      `%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\n% ${body}\ntrailer << /Root 1 0 R >>\n%%EOF\n`,
    ),
  );

describe.runIf(host)("real clamd (pinned image)", () => {
  it("answers PING", async () => {
    expect(await scanner().ping()).toBe(true);
  });

  it("finds the EICAR test file sent as-is", async () => {
    const result = await scanner().scan(new Uint8Array(Buffer.from(EICAR)));
    expect(result.status).toBe("infected");
    expect(result.status !== "clean" && result.detection).toMatch(/eicar/i);
  });

  it("reports a small, well-formed PDF as clean", async () => {
    expect(await scanner().scan(pdf("synthetic receipt"))).toEqual({
      status: "clean",
    });
  });

  it("refuses a stream over StreamMaxLength (12M) as unavailable, never clean", async () => {
    await expect(
      scanner().scan(new Uint8Array(13 * 1024 * 1024)),
    ).rejects.toBeInstanceOf(ScannerUnavailable);
  });
});
