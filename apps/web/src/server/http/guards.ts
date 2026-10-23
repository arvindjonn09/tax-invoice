/**
 * Request guards shared by every route handler (#71,
 * docs/security/requirements.md). withPolicy applies the origin and size
 * checks before authentication; handlers use readJson/parsePage for input.
 */

export class HttpError extends Error {
  constructor(
    readonly status: 400 | 403 | 413 | 415 | 429,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Default JSON request body limit; uploads use signed storage, not bodies. */
export const MAX_JSON_BYTES = 64 * 1024;

/**
 * CSRF defence for route handlers: a state-changing request must carry an
 * Origin header naming the app itself. Browsers always send Origin on
 * cross-site and same-site POST/PUT/PATCH/DELETE; SameSite cookies are a
 * second layer, not the defence.
 */
export function requireTrustedOrigin(
  request: Request,
  trustedOrigins: readonly string[],
): void {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return;
  const origin = request.headers.get("origin");
  if (!origin || !trustedOrigins.includes(origin)) {
    throw new HttpError(403, "Cross-origin request refused");
  }
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    throw new HttpError(403, "Cross-origin request refused");
  }
}

/** Refuse a declared oversized body before reading anything. */
export function requireBodyWithin(request: Request, maxBytes: number): void {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(declared) || declared > maxBytes) {
    throw new HttpError(413, "Request body too large");
  }
}

/**
 * Parse a JSON body of at most `maxBytes`, counting bytes as they stream so a
 * missing or false Content-Length cannot bypass the limit.
 */
export async function readJson(
  request: Request,
  maxBytes = MAX_JSON_BYTES,
): Promise<unknown> {
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/json\b/i.test(type)) {
    throw new HttpError(415, "Send JSON");
  }
  requireBodyWithin(request, maxBytes);
  if (!request.body) throw new HttpError(400, "Request body required");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new HttpError(413, "Request body too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new HttpError(400, "Malformed JSON");
  }
}

export const PAGE_SIZE_DEFAULT = 25;
export const PAGE_SIZE_MAX = 100;

/**
 * Bounded offset pagination from `?page=&pageSize=`. Out-of-range values are
 * clamped, so a client can never request an unbounded list.
 */
export function parsePage(
  params: URLSearchParams,
  { defaultSize = PAGE_SIZE_DEFAULT, maxSize = PAGE_SIZE_MAX } = {},
): { page: number; take: number; skip: number } {
  const integer = (value: string | null, fallback: number) => {
    const parsed = Number(value);
    return value !== null && Number.isSafeInteger(parsed) ? parsed : fallback;
  };
  const take = Math.min(
    maxSize,
    Math.max(1, integer(params.get("pageSize"), defaultSize)),
  );
  // 10,000 pages is far past any real list; it also bounds OFFSET cost.
  const page = Math.min(10_000, Math.max(1, integer(params.get("page"), 1)));
  return { page, take, skip: (page - 1) * take };
}
