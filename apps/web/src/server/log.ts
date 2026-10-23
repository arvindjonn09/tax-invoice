/**
 * Server logging that never records secrets or personal/financial details
 * (docs/security/requirements.md §Logging, #71). Log ids, actions and error
 * classes — never request bodies, uploaded content or raw records.
 */

export const REDACTED = "[redacted]";

/** Keys whose values are always replaced, at any depth (case-insensitive). */
const SENSITIVE_KEY =
  /pass(word)?|secret|token|cookie|authori[sz]ation|session|api[-_]?key|signature|credential|abn|tfn|bsb|account(number|no)?$|bank|card|email|phone|mobile|address|street|postcode|dob|birth|contents?$|body$|file$/i;

/** Values that look sensitive whatever key they sit under. */
const SENSITIVE_PATTERNS: [RegExp, string][] = [
  // Signed URL parameters (S3 / generic).
  [
    /([?&](?:X-Amz-[A-Za-z-]+|Signature|Expires|token|sig|key)=)[^&\s"']+/gi,
    `$1${REDACTED}`,
  ],
  // Bearer / basic credentials.
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/g, `$1 ${REDACTED}`],
  // Email addresses.
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, REDACTED],
  // ABNs, TFNs, phone and bank account numbers: 6+ digits, optionally
  // space-separated. Hyphen/word neighbours are excluded so UUIDs and ISO
  // dates stay readable.
  [/(?<![\w-])\+?\d(?:\s?\d){5,}(?![\w-])/g, REDACTED],
];

function redactString(value: string): string {
  return SENSITIVE_PATTERNS.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    value,
  );
}

/** Deep copy of `value` that is safe to log. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return REDACTED;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Error) return safeError(value);
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SENSITIVE_KEY.test(key) ? REDACTED : redact(item, depth + 1),
    ]),
  );
}

/** Error class and a redacted message; never the cause chain or raw data. */
export function safeError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return { name: error.name, message: redactString(error.message) };
  }
  return { name: "NonError", message: REDACTED };
}

export type LogFields = Record<string, unknown>;

type Sink = (line: string) => void;
let sink: Sink = (line) => console.error(line);

/** Tests capture output here. */
export function setLogSink(next: Sink): () => void {
  const previous = sink;
  sink = next;
  return () => {
    sink = previous;
  };
}

export function log(
  level: "error" | "warn" | "info",
  event: string,
  fields: LogFields = {},
): void {
  sink(
    JSON.stringify({
      level,
      event,
      time: new Date().toISOString(),
      ...(redact(fields) as LogFields),
    }),
  );
}
