# syntax=docker/dockerfile:1
FROM oven/bun:1 AS build
ARG NEXT_PUBLIC_API_BASE_URL=http://api:8000
ARG NEXT_PUBLIC_USE_MOCK_CATALOG=true
ARG NEXT_PUBLIC_CATALOG_POLL_INTERVAL_MS=600000
WORKDIR /app

COPY package.json bun.lock ./
COPY apps/web/package.json apps/web/package.json
RUN bun install --frozen-lockfile --workspaces

COPY apps/web apps/web
RUN bun run --cwd apps/web build

FROM nginx:alpine
COPY --from=build /app/apps/web/out /usr/share/nginx/html
EXPOSE 80
