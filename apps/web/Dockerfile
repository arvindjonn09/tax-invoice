# syntax=docker/dockerfile:1
# JobFlow web image (#64). Build from the repository root:
#   docker build -f apps/web/Dockerfile --target runtime -t jobflow-web .
#   docker build -f apps/web/Dockerfile --target migrate -t jobflow-migrate .
# Pin NODE_IMAGE to a digest in the deploy environment (see docs/ops/staging.md).
ARG NODE_IMAGE=node:24-bookworm-slim

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
