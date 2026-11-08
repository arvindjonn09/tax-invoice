import { createHmac } from "node:crypto";

/** RFC 6238 from the URI the plugin hands back, as an authenticator app does. */
export function totp(uri: string, at = Date.now()) {
  const encoded = new URL(uri).searchParams.get("secret")!;
  let bits = "";
  for (const char of encoded.replace(/=+$/, "")) {
    bits += "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
      .indexOf(char)
      .toString(2)
      .padStart(5, "0");
  }
  const key = Buffer.from(
    (bits.match(/.{8}/g) ?? []).map((byte) => parseInt(byte, 2)),
  );
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const digest = createHmac("sha1", key).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0xf;
  return String(
    (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000,
  ).padStart(6, "0");
}
