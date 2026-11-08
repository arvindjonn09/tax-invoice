import { readFileSync } from "node:fs";
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

/**
 * A password-protected PDF (AES-256, a non-empty user password), so nothing
 * can open it without the password. Committed as a ready-made binary rather
 * than built here, so no password-hashing code lives in the tests; see
 * tests/fixtures/pdf/README.md for how it was made.
 */
export function passwordProtectedPdf(): Uint8Array {
  return new Uint8Array(
    readFileSync(
      new URL("../fixtures/pdf/password-protected.pdf", import.meta.url),
    ),
  );
}
