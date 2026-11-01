# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
# JobFlow web image (#64). Build from the repository root:
#   docker build -f apps/web/Dockerfile --target runtime -t jobflow-web .
#   docker build -f apps/web/Dockerfile --target migrate -t jobflow-migrate .
#   docker build -f apps/web/Dockerfile --target backup -t jobflow-backup .
# The default and deployed build both use this verified multi-arch digest.
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205

FROM ${NODE_IMAGE} AS base
# COREPACK_HOME outside root's home so the non-root migrate job finds the
# prepared pnpm without downloading it (its network has no route out).
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_HOME=/corepack \
    NEXT_TELEMETRY_DISABLED=1 \
    CI=1
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate \
    && chmod -R a+rX /corepack
WORKDIR /repo

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile \
    && pnpm db:generate \
    && NEXT_OUTPUT=standalone pnpm --filter @jobflow/web build

# One-off job: apply migrations with the OWNER role, then (re)grant the
# least-privilege runtime role. The web container never gets owner rights.
FROM base AS migrate
COPY --from=build /repo /repo
USER node
# Plain node: no package-manager lookups at run time.
CMD ["sh", "-c", "node scripts/database/cli.mjs migrate deploy && node scripts/database/apply-runtime-role.mjs"]

# Nightly encrypted backup (#63, #173): the repo's backup CLI plus pg_dump 16
# (matching the server) and the AWS CLI for the off-site copy. Runs on the
# Compose data network, so it reaches PostgreSQL without a published port.
FROM base AS backup
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
    && install -d /usr/share/postgresql-common/pgdg \
    && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
       -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
    && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
       > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends postgresql-client-16 awscli \
    && apt-get purge -y curl gnupg && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /repo /repo
ENV BACKUP_ROOT=/backups \
    HOME=/tmp
USER node
CMD ["sh", "infra/backup/run-backup.sh"]

# The web server: standalone output only, read-only files, non-root.
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /repo/third-party ./third-party
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "apps/web/server.js"]
