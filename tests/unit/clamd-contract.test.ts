import { describe, expect, it } from "vitest";
import {
  ScannerUnavailable,
  clamdScanner,
} from "../../apps/web/src/server/documents/scanner";
import { sniffType } from "../../apps/web/src/server/documents/files";
import { EICAR } from "../helpers/fake-clamd";
import {
  largeVectorPdf,
  passwordProtectedPdf,
  pdfWithAttachment,
  plainPdf,
} from "../helpers/pdf-fixtures";

// #136: the scanner client against a REAL clamd: the pinned image, run by the
// `clamav-contract` CI job hardened as in compose.yml, with
// infra/staging/clamav/clamd.conf. Skipped unless CLAMD_CONTRACT_HOST is set,
// so ordinary test runs never need Docker. The fixtures are checked here too.
const host = process.env.CLAMD_CONTRACT_HOST;
const scanner = () =>
  clamdScanner({
    host: host!,
    port: Number(process.env.CLAMD_CONTRACT_PORT ?? "3310"),
    idleMs: 30_000,
    deadlineMs: 45_000,
  });

describe("contract fixtures", () => {
  it("are PDFs the upload sniffer accepts", () => {
    for (const bytes of [
      plainPdf(),
      largeVectorPdf(),
      pdfWithAttachment(Buffer.from(EICAR)),
      passwordProtectedPdf(),
    ])
      expect(sniffType(bytes)).toBe("application/pdf");
    // The vector page is small on the wire, large once inflated.
    expect(largeVectorPdf().byteLength).toBeLessThan(1024 * 1024);
  });
});

describe.runIf(host)("real clamd (pinned image)", () => {
  it("contract: answers PING", async () => {
    expect(await scanner().ping()).toBe(true);
  });

  it("contract: finds the EICAR test file sent as-is", async () => {
    const result = await scanner().scan(new Uint8Array(Buffer.from(EICAR)));
    expect(result.status).toBe("infected");
  });

  it("contract: finds EICAR attached inside a PDF", async () => {
    const result = await scanner().scan(pdfWithAttachment(Buffer.from(EICAR)));
    expect(result.status).toBe("infected");
  });

  it("contract: reports a small, well-formed PDF as clean", async () => {
    expect(await scanner().scan(plainPdf())).toEqual({ status: "clean" });
  });

  it("contract: accepts a large vector PDF (content inflating to 20 MB)", async () => {
    expect(await scanner().scan(largeVectorPdf())).toEqual({ status: "clean" });
  });

  it("contract: refuses a password-protected PDF as unscannable", async () => {
    const result = await scanner().scan(passwordProtectedPdf());
    expect(result).toMatchObject({ status: "unscannable" });
    expect(result.status !== "clean" && result.detection).toMatch(
      /^Heuristics\.Encrypted/,
    );
  });

  it("contract: refuses a stream over StreamMaxLength as unavailable, never clean", async () => {
    await expect(
      scanner().scan(new Uint8Array(13 * 1024 * 1024)),
    ).rejects.toBeInstanceOf(ScannerUnavailable);
  });
});
