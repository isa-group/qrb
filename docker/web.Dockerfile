# syntax=docker/dockerfile:1
FROM oven/bun:1 AS build
ARG NEXT_PUBLIC_QRB_API=http://localhost:8000
ENV NEXT_PUBLIC_QRB_API=$NEXT_PUBLIC_QRB_API
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

# The root lockfile covers both workspaces, so both manifests must be present.
COPY package.json bun.lock ./
COPY apps/web/package.json apps/web/package.json
COPY apps/gateway/package.json apps/gateway/package.json
RUN bun install --frozen-lockfile --filter web

COPY apps/web apps/web
# Uses the committed data/openapi.json and lib/api/schema.d.ts: this image
# has no Python, so the `openapi` and `api-types` steps of `bun run build` are skipped.
RUN cd apps/web && bunx next build

FROM oven/bun:1
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build /app /app
WORKDIR /app/apps/web
EXPOSE 3000
CMD ["bunx", "next", "start", "-p", "3000"]
