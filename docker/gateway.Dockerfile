# syntax=docker/dockerfile:1
# Gateway image: the Hono/Bun gateway (logins, API keys, quotas). It serves the
# API at /api/* (proxied to the api service) and the website at / (proxied to
# the web service's Next.js server). Build context is the repository root.

# --- 1. Production dependencies ----------------------------------------------
FROM oven/bun:1 AS deps
WORKDIR /app
# The root lockfile covers both workspaces, so both manifests must be present.
COPY package.json bun.lock ./
COPY apps/web/package.json apps/web/package.json
COPY apps/gateway/package.json apps/gateway/package.json
RUN bun install --frozen-lockfile --production --filter gateway

# --- 2. Runtime ----------------------------------------------------------------
FROM oven/bun:1
ENV NODE_ENV=production \
    PORT=3001 \
    HOST=0.0.0.0
WORKDIR /app

COPY --from=deps /app/node_modules /app/node_modules
COPY --from=deps /app/apps/gateway/node_modules /app/apps/gateway/node_modules
COPY apps/gateway/package.json apps/gateway/tsconfig.json /app/apps/gateway/
# Includes src/db/migrations/*.sql (0001 reads its .sql file at runtime).
COPY apps/gateway/src /app/apps/gateway/src

WORKDIR /app/apps/gateway
USER bun
EXPOSE 3001

# /api/health is answered by the gateway itself (it does not call the API).
# bun is used because the image has no curl.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["bun", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["bun", "src/index.ts"]
