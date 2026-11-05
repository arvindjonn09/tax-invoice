import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

// #136: synthetic PDFs for the real-clamd contract tests. Hand-built so the
// tests need no extra library; every fixture is a well-formed PDF that the
// upload sniffer accepts.

/** Assemble a PDF from object bodies (1-based), with a correct xref table. */
function assemble(objects: Buffer[], trailerExtra = ""): Buffer {
  const parts: Buffer[] = [
    Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1"),
  ];
  const offsets: number[] = [];
  let length = parts[0]!.length;
  objects.forEach((body, index) => {
    offsets.push(length);
    const object = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`),
      body,
      Buffer.from("\nendobj\n"),
    ]);
    parts.push(object);
    length += object.length;
  });
  const xref = [
    "xref",
    `0 ${objects.length + 1}`,
    "0000000000 65535 f ",
    ...offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n `),
    "trailer",
    `<< /Size ${objects.length + 1} /Root 1 0 R ${trailerExtra}>>`,
    "startxref",
    String(length),
    "%%EOF",
    "",
  ].join("\n");
  parts.push(Buffer.from(xref, "latin1"));
  return Buffer.concat(parts);
}

const text = (value: string) => Buffer.from(value, "latin1");
const stream = (dict: string, data: Buffer) =>
  Buffer.concat([
    text(`<< ${dict} /Length ${data.length} >>\nstream\n`),
    data,
    text("\nendstream"),
  ]);

function onePage(content: Buffer, contentDict = ""): Buffer[] {
  return [
    text("<< /Type /Catalog /Pages 2 0 R >>"),
    text("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    text(
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R >>",
    ),
    stream(contentDict, content),
  ];
}

/** A one-page PDF with a line of text. */
export function plainPdf(): Uint8Array {
  return new Uint8Array(
    assemble(onePage(text("BT /F1 12 Tf 72 720 Td (Synthetic receipt) Tj ET"))),
  );
}

/**
 * A vector-heavy page, like a large CAD plan: a Flate content stream that
 * inflates to `inflatedBytes` of path operators while the file stays small.
 */
export function largeVectorPdf(inflatedBytes = 20 * 1024 * 1024): Uint8Array {
  const line = "100 100 m 400 700 l S\n";
  const raw = Buffer.alloc(inflatedBytes - (inflatedBytes % line.length), line);
  return new Uint8Array(
    assemble(onePage(deflateSync(raw, { level: 9 }), "/Filter /FlateDecode")),
  );
}

/** A PDF carrying `payload` as an embedded file (an attachment). */
export function pdfWithAttachment(payload: Buffer): Uint8Array {
  return new Uint8Array(
    assemble([
      text(
        "<< /Type /Catalog /Pages 2 0 R /Names << /EmbeddedFiles << /Names [(note.txt) 5 0 R] >> >> >>",
      ),
      text("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
      text(
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R >>",
      ),
      stream("", text("BT /F1 12 Tf 72 720 Td (See attachment) Tj ET")),
      text("<< /Type /Filespec /F (note.txt) /EF << /F 6 0 R >> >>"),
      stream("/Type /EmbeddedFile", payload),
    ]),
  );
}

const PADDING = Buffer.from(
  "28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a",
  "hex",
);

function rc4(key: Buffer, data: Buffer): Buffer {
  const s = Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i += 1) {
    j = (j + s[i]! + key[i % key.length]!) & 255;
    [s[i], s[j]] = [s[j]!, s[i]!];
  }
  const out = Buffer.alloc(data.length);
  let i = 0;
  j = 0;
  for (let n = 0; n < data.length; n += 1) {
    i = (i + 1) & 255;
    j = (j + s[i]!) & 255;
    [s[i], s[j]] = [s[j]!, s[i]!];
    out[n] = data[n]! ^ s[(s[i]! + s[j]!) & 255]!;
  }
  return out;
}

const md5 = (...parts: Buffer[]) =>
  createHash("md5").update(Buffer.concat(parts)).digest();
const pad = (password: string) =>
  Buffer.concat([Buffer.from(password, "latin1"), PADDING]).subarray(0, 32);

/**
 * A password-protected PDF (Standard security handler, V1/R2, RC4 40-bit)
 * whose user password is not empty, so no reader or scanner can open it
 * without the password.
 */
export function passwordProtectedPdf(
  userPassword = "synthetic-user-pass",
  ownerPassword = "synthetic-owner-pass",
): Uint8Array {
  const id = md5(Buffer.from("jobflow-test-fixture"));
  const owner = rc4(md5(pad(ownerPassword)).subarray(0, 5), pad(userPassword));
  const permissions = -4;
  const p = Buffer.alloc(4);
  p.writeInt32LE(permissions);
  const key = md5(pad(userPassword), owner, p, id).subarray(0, 5);
  const user = rc4(key, PADDING);
  // The content is encrypted with the object key, as the handler requires.
  const objectKey = md5(key, Buffer.from([4, 0, 0, 0, 0])).subarray(0, 10);
  const content = rc4(
    objectKey,
    text("BT /F1 12 Tf 72 720 Td (Synthetic receipt) Tj ET"),
  );
  const objects = onePage(content);
  objects.push(
    text(
      `<< /Filter /Standard /V 1 /R 2 /O <${owner.toString("hex")}> /U <${user.toString("hex")}> /P ${permissions} >>`,
    ),
  );
  return new Uint8Array(
    assemble(
      objects,
      `/Encrypt 5 0 R /ID [<${id.toString("hex")}> <${id.toString("hex")}>] `,
    ),
  );
}
