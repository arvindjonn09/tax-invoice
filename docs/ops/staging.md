# Staging environment (#64)

Staging is a production-like copy of JobFlow that holds **synthetic data only**. It has its own server, database, document bucket, keys and secrets. None of them is shared with production.

This repository has the configuration. Creating the server, the DNS name, the bucket and the CI secrets are owner steps, and so is turning on the deploy job. Nothing deploys until the owner does them.

## What runs

`infra/staging/compose.yml` runs four services on one host:

| Service | What it does | Reachable from |
|---|---|---|
| `nginx` | TLS on 443, HTTP→HTTPS redirect, ACME challenges, rate limits | The internet (80, 443) |
| `web` | The Next.js app (`apps/web/Dockerfile`, `runtime` target) | nginx only |
| `postgres` | PostgreSQL 16 | `web` and `migrate`, on a network with no route out |
| `migrate` | One-off: `prisma migrate deploy`, then the runtime-role grants | – |

Documents go to an S3-compatible bucket outside the host (`S3_*` in `web.env`).

**Hardening:**
- **Image:** the web image holds the standalone server only, with no source, tests or `.env` files, and it runs as `node`, not root.
- **Container:** read-only filesystem, all capabilities dropped, `no-new-privileges`.
- **Database roles:**
  - The app connects as `jobflow_web`, a member of `jobflow_app`. That role reads and writes rows only. It can't run DDL, disable triggers, or change or delete the audit log (`packages/database/prisma/roles/runtime-role.sql`, tested in `tests/integration/runtime-role.test.ts`).
  - Only the `migrate` job uses the owner role.
- **Client IP:** nginx **overwrites** `X-Forwarded-For` with the connecting address. The app throttles by the first hop, so a client can't pick its own IP.
- **HTTPS:**
  - `BETTER_AUTH_URL` is `https://…`, so cookies are `Secure` and the app sends HSTS. nginx sends HSTS on its own error pages too.
  - TLS 1.2 and 1.3 only.
- **Rate limits:** `/api/auth/` is limited to 10 requests a minute per IP (burst 5), and the rest of `/api/` to 20 a second. These sit on top of the app's own throttles.
- **Upload size:** request bodies are capped at 11 MiB, which allows for the 10 MiB document limit.

## Health checks

- **`GET /api/health` (liveness):** says the process is up. The image's `HEALTHCHECK` uses it.
- **`GET /api/health/ready` (readiness):** 200 only when the database answers a query and document storage is configured, otherwise 503. It never says which part failed. The deploy smoke test uses it.

## Logs and alerts

- **App logs:** the app writes redacted JSON lines to stdout (`apps/web/src/server/log.ts`).
- **Rotation:** Docker keeps 5 × 10 MB per container.
- **Reading logs:** `docker compose -f infra/staging/compose.yml logs -f web`.
- **Alerts:** point an external uptime monitor at `https://<staging>/api/health/ready`, checking every minute and alerting after 3 failures. Alert the owner too when the nightly backup unit fails (`systemctl --failed`, see [backups.md](backups.md)).

## First-time setup (owner)

1. **Server:** a small Linux VM in an Australian region with Docker Engine and the Compose plugin.
   - Open only ports 22 (restricted), 80 and 443.
   - Create a `deploy` user in the `docker` group.
2. **DNS:** `staging.<domain>` → the server.
3. **Bucket:** a private bucket in `ap-southeast-2`, with public access blocked, default encryption on and versioning on. Create an access key that can reach **this bucket only**.
4. **Code and secrets on the host:**
   - Clone the repo to `/opt/jobflow`.
   - For each file in `infra/staging/env/*.env.example`, copy it to the same name without `.example`.
   - Fill in **new random values**: `openssl rand -base64 32`. The owner and runtime database passwords must differ.
   - Make the files private: `chmod 600 infra/staging/env/*.env`. They're git-ignored; never commit them.
   - Staging keys are never production keys.
5. **First certificate**, before nginx is running:

   ```sh
   cd /opt/jobflow
   docker compose -f infra/staging/compose.yml --env-file infra/staging/env/compose.env --profile certbot \
     run --rm -p 80:80 certbot certonly --standalone -d staging.<domain> --email <ops email> --agree-tos --no-eff-email
   ```

6. **Start:** `sudo -u deploy SSH_ORIGINAL_COMMAND="deploy $(git rev-parse origin/main)" infra/staging/deploy.sh`.
7. **Renewal:** a weekly cron job on the host:

   ```sh
   docker compose -f infra/staging/compose.yml --env-file infra/staging/env/compose.env --profile certbot \
     run --rm certbot renew --webroot -w /var/www/acme \
   && docker compose -f infra/staging/compose.yml exec nginx nginx -s reload
   ```

8. **Synthetic data:** load the flagged demo data, which carries the "Demo Data" indicator. Never load an export of real data.

   ```sh
   docker compose -f infra/staging/compose.yml run --rm -e DEMO_SEED=yes -e DEMO_PASSWORD=<12+ chars> migrate pnpm db:seed:demo
   ```

9. **Backups:** install the nightly backup timer with a **staging-only** `BACKUP_ENCRYPTION_KEY` ([backups.md](backups.md)).

## Deploying from CI (owner turns it on)

`.github/workflows/staging.yml` always does three things:
- builds both images
- checks that the runtime image is non-root and holds no source or `.env` files
- smoke-tests liveness and readiness, and validates the Compose and nginx files

Its `deploy` job runs only on pushes to `main`, and only when every item below is set up.

**Repository variables:**
- `STAGING_DEPLOY_ENABLED=true`
- `STAGING_URL=https://staging.<domain>`

**The `staging` environment:**
- Add required reviewers, so every deploy is approved.
- Add these secrets:
  - `STAGING_SSH_KEY`: a new ed25519 key used only for this.
  - `STAGING_SSH_TARGET`: `deploy@staging.<domain>`.
  - `STAGING_SSH_KNOWN_HOSTS`: from `ssh-keyscan`, checked against the host's fingerprint.

**On the host:**
- Install the public key in `~deploy/.ssh/authorized_keys` as a forced command. The full line is in the header of `infra/staging/deploy.sh`.
- With the forced command, the key can do one thing: check out a commit that is already on `origin/main`, then build, migrate and restart.

The job then polls `/api/health/ready` until it answers 200.

**Rolling back:** deploy the previous `main` commit the same way. Migrations only go forward. If one has to be undone, use its file in `packages/database/prisma/rollbacks/` during a maintenance window, or restore a backup.

## Before you call staging done

- Restore drill on staging passes ([backups.md](backups.md#restore-drills)).
- `https://staging.<domain>` gets an A on an SSL test, and `http://` redirects.
- Sign-in from another origin is refused, and the session cookie is `Secure; HttpOnly`.
- `curl -H 'X-Forwarded-For: 1.2.3.4'` still gets throttled by the real IP after the limit.
- No real customer, employee or ABN data anywhere: the database, the bucket or the logs.
