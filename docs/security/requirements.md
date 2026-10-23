# Web security baseline

Status: implemented in M0 ([#71](https://github.com/arvindjonn09/tax-invoice/issues/71)). Every new route, page,
export, upload or PDF endpoint must meet this baseline; reviewers check it. Threat references are to
[threat-model.md](threat-model.md).

## 1. Response headers (T08, T09)

Set on every page and API response by [`apps/web/src/proxy.ts`](../../apps/web/src/proxy.ts) from
[`server/security/headers.ts`](../../apps/web/src/server/security/headers.ts).

| Header | Value | Why |
|---|---|---|
| `Content-Security-Policy` | `default-src 'self'; script-src 'self' 'nonce-…' 'strict-dynamic'; style-src 'self' 'nonce-…'; style-src-attr 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; frame-src 'none'; worker-src 'self' blob:; manifest-src 'self'` (+ `upgrade-insecure-requests` over HTTPS) | Stops injected script; fresh 128-bit nonce per request |
| `X-Frame-Options` | `DENY` | Clickjacking (with `frame-ancestors 'none'`) |
| `X-Content-Type-Options` | `nosniff` | No MIME sniffing of uploads or JSON |
| `Referrer-Policy` | `same-origin` | Paths with ids or signed parameters never leave the origin |
| `Permissions-Policy` | camera, microphone, geolocation, payment, usb off | Least privilege |
| `Cross-Origin-Opener-Policy` / `-Resource-Policy` | `same-origin` | Cross-window and cross-site isolation |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains` — **only when served over HTTPS** | No preload until the production domain is fixed (#64) |
| `X-Powered-By` | removed (`poweredByHeader: false`) | |

Rules:
- Pages must render dynamically so Next.js can apply the nonce (the root layout reads `headers()`). Never add
  `'unsafe-inline'` or `'unsafe-eval'` to `script-src` in production. `next dev` alone adds `'unsafe-eval'` and inline
  styles for hot reload.
- Inline style *attributes* are allowed (`style-src-attr`); they cannot run script.
- Third-party scripts, fonts or frames need a security review and an explicit CSP change. Fonts are self-hosted.

## 2. Sessions and CSRF (T01, T09)

- Cookies: `HttpOnly`, `SameSite=Lax`, `Path=/`, `__Secure-` prefix and `Secure` whenever the app URL is HTTPS or the
  environment is production ([ADR 0003](../adr/0003-authentication.md), #13). 12-hour sessions, revocable rows.
- **Route handlers:** `withPolicy` refuses any POST/PUT/PATCH/DELETE whose `Origin` is missing or not the app's own
  origin (`BETTER_AUTH_URL`), or whose `Sec-Fetch-Site` is `cross-site` — **before** authentication. Unconfigured
  origin ⇒ every mutation refused. SameSite is a second layer, not the defence.
- **Better Auth endpoints:** origin and CSRF checks pinned on in every environment.
- **Server actions:** Next.js rejects an action whose `Origin` differs from the `Host`; `serverActions.allowedOrigins`
  must stay unset (unit-tested). Every action must also call `requireActor(...)` (route-policy test) — hidden buttons
  are not access control.
- No state change on GET.

## 3. Caching (T03)

- All authenticated JSON goes through `privateJson` → `Cache-Control: private, no-store`, including 401/403/404/413/500.
- Pages render dynamically, so Next.js sends `private, no-cache, no-store` for them.
- Downloads (PDF/CSV, #48/#56) and signed-URL responses must also be `private, no-store` with
  `Content-Disposition: attachment` and an explicit `Content-Type`.
- Tests: two sessions read their own company with private headers
  (`tests/integration/authorization.test.ts`, "serves each session its own company").

## 4. Input limits and throttles

| Control | Limit | Where |
|---|---|---|
| JSON request body | 64 KiB default (`withPolicy(..., { maxBodyBytes })` to change), declared size checked first, streamed bytes counted | `server/http/guards.ts` (`readJson`) |
| Content type | `application/json` only for JSON handlers (415 otherwise) | `readJson` |
| Lists | `parsePage`: default 25, max 100 per page, page ≤ 10,000 | `server/http/guards.ts` |
| Exports (CSV, #56) | 5 per minute per user **and** per IP | `throttle(db, "export", …)` |
| PDF render (#48) | 20 per minute | `"pdf"` |
| Document upload (#34) | 10 MiB per file, multipart only; type from the file's bytes (PDF, JPEG, PNG, WebP, HEIC) | `server/documents` |
| Download links (#34) | 60 per minute, 5-minute expiry | `"download.sign"` |
| Sign-in | 5 per minute per IP (Better Auth, #13) | `auth/config.ts` |

Throttle counters are atomic rows in the shared database (`auth_rate_limits`, `jobflow:` prefix), so they hold across
server instances. Files are uploaded **through the app** (#34), so the server can check the real bytes: a streaming
10 MiB cap, a content-sniffed type allow-list (the client's type and file name are never trusted), a random object
key and a sanitised display name. Bytes go to a private S3-compatible bucket that browsers never reach directly.
Downloads use a 5-minute HMAC-signed link to `/api/files/<token>`, issued only after an authorisation check (office
roles: any company document; everyone else: their own uploads). The link is bound to the document and company, and is
served as an attachment with `Content-Security-Policy: default-src 'none'; sandbox`, `nosniff` and
`private, no-store`, so a file can never run as a page in the app's origin. Expired links return 410; forged or
cross-company links return 404.
The client IP is the first `X-Forwarded-For` hop, so the production reverse proxy (#64) **must overwrite** that header.

## 5. Logging and errors (T03)

- Log through `server/log.ts` only. It writes JSON lines and redacts:
  - keys: password, secret, token, cookie, authorization, session, API key, signature, credential, ABN, TFN, BSB,
    account number, bank, card, email, phone, address, date of birth, body/contents/file;
  - values: signed URL parameters, bearer credentials, email addresses, and runs of 6+ digits (ABN, TFN, phone,
    account numbers). UUIDs and ISO dates stay readable.
- Never log request bodies, uploaded content, raw records or error causes/stacks with data.
- Unexpected route errors return `{ "error": "Something went wrong. Try again.", "reference": "<uuid>" }` (500); the
  reference links to the redacted log line. Expected errors return a short, safe message.
- Better Auth logs at `error` level through the same redactor.
- Tests: `tests/unit/security-baseline.test.ts` (synthetic secrets of every kind),
  `tests/integration/authorization.test.ts` (500 path).

## 6. Database privileges (T05, T06)

- The app connects as a **runtime role** that is a member of `jobflow_app`
  ([`roles/runtime-role.sql`](../../packages/database/prisma/roles/runtime-role.sql)): row DML only, no DDL, not an
  owner, not a superuser; `audit_events` is INSERT/SELECT only; `_prisma_migrations` unreadable.
- Migrations use a separate owner credential that the running app never holds.
- `tests/integration/runtime-role.test.ts` proves, as `jobflow_app`, that audit UPDATE/DELETE/TRUNCATE, trigger
  disable/drop, function drop, `session_replication_role = replica`, `CREATE TABLE` and `DROP TABLE` all fail.

## 7. Verification

| Check | Evidence |
|---|---|
| Header, CSP and cross-origin unit tests | `tests/unit/security-baseline.test.ts` |
| withPolicy origin/size/500/cache tests, throttle atomicity | `tests/integration/authorization.test.ts` |
| Runtime role cannot bypass audit | `tests/integration/runtime-role.test.ts` |
| Live headers, fresh nonce per view, no CSP violations during hydration, cross-origin PATCH → 403 | `tests/e2e/security-headers.spec.ts` (dev server in CI; also run against `next start` before merging #71) |

## 8. Deployment-only checks (for #64)

These cannot be verified in CI and must be ticked during the production pilot set-up:

- [ ] HTTPS only; HTTP redirects to HTTPS; TLS 1.2+.
- [ ] `BETTER_AUTH_URL` is the exact public `https://` origin, so origin checks, Secure cookies, HSTS and
      `upgrade-insecure-requests` all apply. `APP_ENV=production`.
- [ ] Response headers verified on the live domain (e.g. `curl -sI`), including HSTS; consider HSTS preload only
      after the domain is final.
- [ ] Reverse proxy overwrites `X-Forwarded-For`/`X-Real-IP` (client-supplied values would defeat IP throttles) and
      enforces a request body cap ≥ the app's limits.
- [ ] App `DATABASE_URL` uses a login role in `jobflow_app`; migration credentials are separate and not on the app
      host. Run `runtime-role.sql` after each `migrate deploy`.
- [ ] Logs are shipped to private storage with retention set; spot-check that no secret or contact detail appears.
- [ ] Storage bucket private, CORS limited to the app origin (#34).
