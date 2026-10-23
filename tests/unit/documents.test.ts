import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  LINK_TTL_SECONDS,
  safeFileName,
  signLink,
  sniffType,
  verifyLink,
} from "../../apps/web/src/server/documents/files";
import { S3Store } from "../../apps/web/src/server/documents/store";

const bytes = (...parts: (string | number[])[]) =>
  new Uint8Array(
    parts.flatMap((part) =>
      typeof part === "string" ? [...Buffer.from(part, "latin1")] : part,
    ),
  );

describe("file type sniffing (#34)", () => {
  it("recognises the allowed types from their bytes", () => {
    expect(sniffType(bytes("%PDF-1.7\n"))).toBe("application/pdf");
    expect(sniffType(bytes([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(
      sniffType(bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])),
    ).toBe("image/png");
    expect(sniffType(bytes("RIFF", [0, 0, 0, 0], "WEBPVP8 "))).toBe(
      "image/webp",
    );
    expect(sniffType(bytes([0, 0, 0, 24], "ftypheic", [0]))).toBe("image/heic");
  });

  it("refuses HTML, SVG, scripts, archives and anything unknown, whatever the name", () => {
    for (const content of [
      "<!doctype html><script>alert(1)</script>",
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
      "PK\u0003\u0004",
      "#!/bin/sh",
      "",
      "%PDF",
    ])
      expect(sniffType(bytes(content)), content).toBeNull();
  });

  it("makes safe display names with the real type's extension", () => {
    expect(safeFileName("../../etc/passwd", "application/pdf")).toBe(
      "passwd.pdf",
    );
    expect(safeFileName("C:\\Users\\x\\Receipt 12.exe", "image/jpeg")).toBe(
      "Receipt 12.jpg",
    );
    expect(safeFileName('<img src=x onerror="1">.png', "image/png")).toBe(
      "img srcx onerror1.png",
    );
    expect(safeFileName("", "image/webp")).toBe("document.webp");
    expect(safeFileName("a".repeat(500), "application/pdf")).toHaveLength(104);
  });
});

describe("signed download links (#34)", () => {
  const secret = randomBytes(32).toString("hex");
  const claims = {
    documentId: "d0000000-0000-4000-8000-000000000001",
    companyId: "c0000000-0000-4000-8000-000000000001",
    exp: Math.floor(Date.now() / 1000) + LINK_TTL_SECONDS,
  };

  it("verifies a fresh link and returns its claims", () => {
    expect(verifyLink(signLink(claims, secret), secret)).toEqual({
      ok: true,
      claims,
    });
  });

  it("fails once expired", () => {
    const token = signLink(claims, secret);
    expect(verifyLink(token, secret, (claims.exp + 1) * 1000)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("rejects tampered claims, other secrets and malformed tokens", () => {
    const token = signLink(claims, secret);
    const [, mac] = token.split(".");
    const forged = `${Buffer.from(
      JSON.stringify({ ...claims, companyId: "other" }),
    ).toString("base64url")}.${mac}`;
    for (const bad of [
      forged,
      signLink(claims, randomBytes(32).toString("hex")),
      "",
      "abc",
      `${token}.extra`,
      token.slice(0, -2),
    ])
      expect(verifyLink(bad, secret)).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("S3 bucket initialisation (#110 review)", () => {
  const settings = {
    bucket: "jobflow-documents",
    region: "us-east-1",
    accessKeyId: "test",
    secretAccessKey: "test",
  };
  const command = (input: unknown) =>
    (input as { constructor: { name: string } }).constructor.name;

  it("retries after a transient failure instead of caching it, and never creates an existing bucket", async () => {
    const calls: string[] = [];
    let headFailures = 1;
    const client = {
      send: async (input: unknown) => {
        const name = command(input);
        calls.push(name);
        if (name === "HeadBucketCommand" && headFailures-- > 0)
          throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
        return {};
      },
    };
    const store = new S3Store(settings, client as never);
    await expect(
      store.put("k", new Uint8Array([1]), "image/png"),
    ).rejects.toThrow("timeout");
    await store.put("k", new Uint8Array([1]), "image/png");
    expect(calls).toEqual([
      "HeadBucketCommand",
      "HeadBucketCommand",
      "PutObjectCommand",
    ]);
  });

  it("creates the bucket only when S3 says it is missing", async () => {
    const calls: string[] = [];
    let first = true;
    const client = {
      send: async (input: unknown) => {
        const name = command(input);
        calls.push(name);
        if (name === "HeadBucketCommand" && first) {
          first = false;
          throw Object.assign(new Error("missing"), {
            name: "NotFound",
            $metadata: { httpStatusCode: 404 },
          });
        }
        return {};
      },
    };
    const store = new S3Store(settings, client as never);
    await store.delete("k");
    await store.delete("k2");
    expect(calls).toEqual([
      "HeadBucketCommand",
      "CreateBucketCommand",
      "DeleteObjectCommand",
      "DeleteObjectCommand",
    ]);
  });
});
