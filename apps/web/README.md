# QRB (Quantum Resource Binder) — Web

The QRB frontend: Next.js (App Router, static export) + Tailwind v4 + shadcn/ui,
following `.claude/DESINGN.md`'s design system. Talks to `apps/api` (FastAPI)
directly from the browser — no server-side proxy.

## Develop

```bash
bun install          # from the repo root, or `bun install` here
bun run dev          # http://localhost:3000
```

By default the Catalog/Playground/Resource Detail pages use a small mock
catalog (`lib/api/mock-catalog.ts`), since real IBM Quantum / Amazon Braket
credentials usually aren't available. Copy `.env.example` (repo root) to
`.env.local` here and set `NEXT_PUBLIC_USE_MOCK_CATALOG=false` once
`apps/api` has live credentials configured — see its `WEB_ORIGINS` CORS
setting too.

## Build & deploy

```bash
bun run build         # static export -> out/
bun run deploy        # build + `wrangler pages deploy` (needs `wrangler login`)
```

Resource Detail uses query-string routing (`/catalog/resource?id=...`, not a
`[id]` path segment) since a static export can't enumerate paths for a live,
changing catalog.

## Regenerating the typed API client

`lib/api/schema.d.ts` is generated from `apps/api`'s live OpenAPI schema and
committed (the static build has no Python environment to regenerate it from):

```bash
bun run generate:api-types   # needs `uv sync --all-packages` at the repo root first
```
