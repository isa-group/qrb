# syntax=docker/dockerfile:1
# Gateway image: the Hono/Bun gateway PLUS the static web build it serves.
# One process, one origin: `/` is the web app, `/api/*` is auth + the proxied
# Python API. Build context is the repository root.

# --- 1. Static web export (apps/web/out) -----------------------------------
FROM oven/bun:1 AS web-build
# NEXT_PUBLIC_* are inlined into the static export at build time.
# Leave NEXT_PUBLIC_API_BASE_URL empty: the web app then calls /api on its own
# origin, which is the gateway.
ARG NEXT_PUBLIC_API_BASE_URL=
ARG NEXT_PUBLIC_USE_MOCK_CATALOG=false
ARG NEXT_PUBLIC_CATALOG_POLL_INTERVAL_MS=600000
ARG NEXT_PUBLIC_TURNSTILE_SITE_KEY=
WORKDIR /app

# The root lockfile covers both workspaces, so both manifests must be present.
COPY package.json bun.lock ./
COPY apps/web/package.json apps/web/package.json
COPY apps/gateway/package.json apps/gateway/package.json
RUN bun install --frozen-lockfile --filter web

COPY apps/web apps/web
RUN bun run --cwd apps/web build

# --- 2. Gateway production dependencies ------------------------------------
FROM oven/bun:1 AS gateway-deps
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/web/package.json apps/web/package.json
COPY apps/gateway/package.json apps/gateway/package.json
RUN bun install --frozen-lockfile --production --filter gateway

# --- 3. Runtime -------------------------------------------------------------
FROM oven/bun:1
ENV NODE_ENV=production \
    PORT=3001 \
    HOST=0.0.0.0 \
    WEB_ROOT=/app/web
WORKDIR /app

# With --filter, bun installs the gateway's dependencies into its own
# apps/gateway/node_modules (the root node_modules stays empty).
COPY --from=gateway-deps /app/apps/gateway/node_modules /app/apps/gateway/node_modules
COPY --from=gateway-deps /app/apps/gateway/package.json /app/apps/gateway/package.json
# Includes src/db/migrations/*.sql (0001 reads its .sql file at runtime).
COPY apps/gateway/src /app/apps/gateway/src
# Committed FastAPI schema snapshot, imported by src/openapi.ts at startup.
COPY apps/gateway/openapi /app/apps/gateway/openapi
COPY apps/gateway/tsconfig.json /app/apps/gateway/tsconfig.json
COPY --from=web-build /app/apps/web/out /app/web

WORKDIR /app/apps/gateway
USER bun
EXPOSE 3001

# /api/health is answered by the gateway itself (it does not call the API).
# bun is used because the image has no curl.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["bun", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["bun", "src/index.ts"]
