# Cloudflare: tunnel, client IP, caching, HSTS and Turnstile (#213)

The self-hosted site sits behind Cloudflare. Nothing on this host accepts traffic from the internet: a Cloudflare Tunnel (`cloudflared`) makes an outbound connection and Cloudflare sends visitors down it.

```
visitor ─▶ Cloudflare edge ─▶ tunnel (cloudflared on this host)
        ─▶ nginx gate 127.0.0.1:3299 (maintenance page, #326)
        ─▶ app 127.0.0.1:3300 (jobflow.service)
```

The staging Compose stack has its own nginx and doesn't use these steps; see [staging.md](staging.md).

## Why nobody can fake their address

- nginx and the app both listen on `127.0.0.1` only. The only way in is the tunnel.
- Cloudflare sets `CF-Connecting-IP` to the visitor's real address and overwrites anything the visitor sent in that header.
- The gate passes headers through unchanged (`infra/host/nginx-gate.conf`), so the app reads the client address from `CF-Connecting-IP`, set by `CLIENT_IP_HEADER=cf-connecting-ip` in `.env`. Sign-in, sign-up and reset throttles use it (`apps/web/src/server/http/throttle.ts`), and values that aren't IP addresses are ignored.
- Close inbound ports with the host firewall anyway, so a future change to a listen address can't expose anything:

  ```sh
  sudo ufw default deny incoming && sudo ufw allow in on tailscale0 && sudo ufw enable
  sudo ufw status verbose
  ```

  Tailscale stays reachable for administration. The tunnel needs no inbound rule. **Before enabling it, confirm you're connected over Tailscale** (`tailscale status`), not over the local network, or the change will cut off your own session.

## Settings in `.env`

| Setting | Value on the self-hosted site |
|---|---|
| `BETTER_AUTH_URL` | `https://jobflow.shivomsangha.com` |
| `CLIENT_IP_HEADER` | `cf-connecting-ip` |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | The site's Turnstile widget keys (Cloudflare dashboard → Turnstile). Set both together. |
| `JOBFLOW_OPERATOR_USER_IDS` | The operator's **user ID** (not their email), from `pnpm operator grant` output. See [operator.md](operator.md). |
| `EMAIL_OUTBOX_KEY` | 32+ random characters. Never change it while email is queued. |

**Turnstile outside production:**
- Leave the keys unset, and the check is skipped.
- Or use Cloudflare's documented test keys: site key `1x00000000000000000000AA` with secret `1x0000000000000000000000000000000AA` always pass.
- Site key `2x00000000000000000000AB` always fails, which is useful for testing the refusal.

In production, a missing secret refuses every sign-up, public resend and forgot-password request. It fails closed.

## Cloudflare dashboard settings

Apply these to the `shivomsangha.com` zone. They are reproducible steps; re-check them after any Cloudflare plan or zone change.

1. **Tunnel** (Zero Trust → Networks → Tunnels): the public hostname `jobflow.shivomsangha.com` points at `http://localhost:3299`, the nginx gate, **not** 3300. Pointing it at 3300 skips the maintenance page.
2. **SSL/TLS → Overview:** Full (strict). Traffic to the origin goes through the tunnel either way.
3. **SSL/TLS → Edge Certificates:**
   - Always Use HTTPS on.
   - HSTS on: max-age 12 months, include subdomains, no preload until every subdomain is HTTPS-only.
   - Minimum TLS version 1.2.
4. **Caching → Cache Rules:** one rule, **"Bypass cache except Next.js static assets"**:
   - When incoming requests match: hostname equals `jobflow.shivomsangha.com` **and** URI path does **not** start with `/_next/static/`.
   - Then: Cache eligibility → **Bypass cache**.

   App pages and API responses carry tenant data; they must never be stored at the edge. The app also sends `Cache-Control: private, no-store` on them, so this rule is a second guard.
5. **Speed → Optimization**, all **off**: Rocket Loader, Auto Minify (if shown), Email Address Obfuscation (Scrape Shield), Always Online (Caching → Configuration), and Zaraz. They rewrite pages or serve stale copies, which breaks the content security policy and can show one user's page to another.
6. **Turnstile:** a widget for `jobflow.shivomsangha.com`, mode Managed. Put its keys in `.env` (above) and restart the app.
7. **Optional, Cloudflare Access for `/operator`:** an Access application on `jobflow.shivomsangha.com/operator*` allowing only the operator's email. The app already needs an operator row, the allowlist and TOTP; Access adds a layer before the page loads.

## Check it

```sh
node scripts/ops/check-edge-cache.mjs https://jobflow.shivomsangha.com
```

The script asks for each app page and API route twice, and checks that:
- each response has `Cache-Control` with `private` and `no-store` (except the cached-by-design static assets);
- Cloudflare never answers `cf-cache-status: HIT` for them;
- `Strict-Transport-Security` is present.

It also checks that a `/_next/static/` asset *is* cacheable.

To include signed-in pages, sign in as two different synthetic or demo users in two browser profiles. Copy each session cookie (the whole `Cookie` header value), then run:

```sh
JOBFLOW_EDGE_COOKIE_A='…' JOBFLOW_EDGE_COOKIE_B='…' \
  node scripts/ops/check-edge-cache.mjs https://jobflow.shivomsangha.com
```

It then also fetches `/dashboard` and `/api/auth/get-session` as each user, and fails if either response is cached, or if user B ever receives user A's response. Cookies are read from the environment, never printed. Never use a real customer's session. Record the output in the issue or PR.

## Owner actions

These need the owner's Cloudflare account:
- [x] Create the tunnel and the `jobflow.shivomsangha.com` hostname (done; it points at 3299 since 2026-11-08).
- [x] Create the Turnstile widget and put its keys in `.env` (done; sign-up refuses tokenless requests).
- [ ] Apply the cache rule and turn off the optimisations in steps 4–5.
- [ ] Turn on edge HSTS (step 3). The app already sends HSTS, so this is a second guard.
- [ ] Optional: Cloudflare Access for `/operator`.
- [ ] Enable the host firewall (above).
