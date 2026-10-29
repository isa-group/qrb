# Tasks

The repo has no unit tests for `apps/api` and no test runner in `apps/web`.
Each Python or gateway task adds its own tests (`pytest` under
`apps/api/tests/`, `bun test` under `apps/gateway/`). Web tasks verify with
`bun run --cwd apps/web lint`, `bun run --cwd apps/web build` and the
manual check each task names. Check Better Auth plugin options against its
current documentation before relying on them (design.md, "Better Auth for
identity").

## 1. Python API hardening

- [x] 1.1 [standard] Reject `snapshot_path` on `POST /select` and `POST /instance` with 422 (no file read, `detail` does not reveal whether the file exists), and make `live: false` read only the server-configured snapshot; verified when new `apps/api/tests/test_inputs.py` covers both http-api "Snapshot path trust" scenarios and `uv run pytest apps/api -q` passes
- [x] 1.2 [standard] Parse `circuit_qasm` as OpenQASM 3 text only, never as a file path; verified when a test sends the path of an existing repo file and gets the same 422 as any invalid text, and `uv run pytest apps/api -q` passes
- [x] 1.3 [heavy] Require the `X-QRB-Gateway-Secret` header on every route except `/health`, bind the API to a private interface only, and remove its public CORS (keep `WEB_ORIGINS` for local dev only); verified when tests show 401 without the secret and no catalog fetch or solve happens, and `uv run pytest apps/api -q` passes. Heavy: security boundary between the public gateway and the private API

## 2. Gateway foundation

- [x] 2.1 [light] Scaffold `apps/gateway` (Hono on Bun, TypeScript) with `GET /health`, a `bun test` setup, and `task gateway:dev` and `task gateway:test` entries in `Taskfile.yml`; verified when `task gateway:test` runs one passing health test. Light: boilerplate copying the repo's existing Bun and Taskfile patterns
- [x] 2.2 [standard] Forward the public paths (`/select`, `/instance`, `/catalog`, `/catalog/{candidate_id}`, `/engines`, `/presets`) to FastAPI. Add the shared secret, strip any client-sent copy of it, pass the caller's user id in a header, and return status and body unchanged; verified when gateway tests against a stub upstream cover the "Single public entry point" scenarios
- [x] 2.3 [standard] Reject `snapshot_path` in the gateway before forwarding (422); verified when a gateway test shows the upstream stub is never called
- [x] 2.4 [heavy] Postgres schema and migrations for Better Auth tables, daily usage counters (user and UTC day; IP and UTC day) and sliding-window rate-limit buckets, with a migration command in the Taskfile; verified when migrations apply to an empty Postgres and roll back cleanly in a test run. Heavy: new data model and migrations shared by auth, quotas and rate limits
- [x] 2.5 [standard] Serve the static web build (`apps/web/out`) from the gateway at `/`, with the API under `/api/*`. Resolve Next's exported routes (`/playground` → `playground.html`) and serve its 404 page; verified when gateway tests show `/`, `/playground` and `/catalog/resource` load, a missing path returns the 404 page, and `/api/health` still answers
- [x] 2.6 [standard] Credentialed CORS in the gateway for the http-api "Cross-origin access" requirement: allow credentials only for origins in `WEB_ORIGINS` (dev; default `http://localhost:3000`, `http://localhost:3002`), no CORS headers for other origins, preflight handled for `/api/*` including `/api/auth/*` and `/api/keys`; verified when gateway tests cover both http-api "Cross-origin access" scenarios and a preflight from an allowed and an unlisted origin

## 3. Identity

- [x] 3.1 [heavy] Configure Better Auth in the gateway:
  - GitHub OAuth, and ORCID through generic OAuth, as the only sign-in methods
  - session cookies `HttpOnly`, `Secure` (outside dev) and `SameSite=Lax`
  - trusted origins from `WEB_ORIGINS`
  - Better Auth's auth-route rate limiter on Postgres storage
  - automatic account merge only on a provider-verified matching email
  - manual link and unlink while signed in, keeping at least one provider linked

  Verified when gateway tests (with mocked OAuth providers) cover the "Accounts", "Account merging on verified email" and "Manual account linking" scenarios, including the unverified-email and no-email cases. Heavy: security-critical auth configuration
- [x] 3.2 [heavy] Anonymous identities through Better Auth's anonymous plugin, created on the first request that needs one, and linked on sign-in so that today's counted units carry over to the account; verified when tests cover the "Anonymous identity" and "Linking anonymous use to an account" scenarios. Heavy: shared state across auth and quotas, and the worker must confirm the plugin's linking hook or design a substitute
- [x] 3.3 [standard] API keys for signed-in users:
  - create (secret shown once), list (name, prefix and creation time only) and revoke
  - authenticate through the `x-api-key` header
  - revoked or unknown keys get 401 and are not counted

  Verified when tests cover the "API keys" scenarios

## 4. Limits

- [x] 4.1 [heavy] Quota engine:
  - daily units per user, reset at 00:00 UTC
  - one unit per resolve, plus a configurable weight when `force_refresh` is set
  - API keys draw from their owner's quota
  - a concurrency-safe check before forwarding, committed only when the upstream does not answer 5xx
  - no charge for requests rejected with 4xx

  Verified when tests cover the "Daily resolve quota", "Live refresh costs more" and "Failed requests are not charged" scenarios, including parallel requests at the limit. Heavy: shared state and concurrency
- [x] 4.2 [standard] Route policy:
  - open routes are callable without identity, with a per-IP limit
  - `/select` and `/instance` need an identity (401 otherwise)
  - anonymous or unidentified `force_refresh: true` gets 403 and is not counted

  Verified when tests cover the "Open routes", "Resolve routes need an identity" and "Anonymous users get the cached catalog only" scenarios
- [x] 4.3 [heavy] Per-IP daily cap shared by all anonymous identities, and sliding-window burst limits per identity and per API key. Client IP comes from `X-Forwarded-For` only when the connection comes from an address in `TRUSTED_PROXIES` (default `127.0.0.1`, `::1`), using the right-most untrusted entry; otherwise it is the socket's remote address. Verified when tests cover the "Per-IP cap on anonymous use" and "Burst rate limits" scenarios, a spoofed `X-Forwarded-For` from an untrusted address, and a multi-hop header. Heavy: security-sensitive client IP handling and shared counters
- [x] 4.4 [standard] CAPTCHA (Cloudflare Turnstile) verification on anonymous resolves; signed-in users and API keys skip it; verified when tests with a stubbed verifier cover the "CAPTCHA for anonymous resolves" scenario
- [x] 4.5 [standard] 429 responses with a `detail` naming the limit and a `Retry-After` header, a remaining-units header on counted requests, and a usage endpoint (tier, quota, used today, time to reset); verified when tests cover the "Limit responses" and "Usage endpoint" scenarios
- [x] 4.6 [standard] Make the limits configurable through environment variables, with the design's proposed defaults, plus a log-only mode that records but does not enforce; verified when a test toggles log-only mode and sees no 429 while counters still increase

## 5. API schema and docs

- [x] 5.1 [standard] Gateway OpenAPI schema: the forwarded paths (taken from FastAPI's schema), plus the auth, API-key and usage routes, plus the 401/403/429 responses. Serve `/scalar` from the gateway and point `apps/web/scripts/generate-api-types.sh` at the gateway schema; verified when `bun run --cwd apps/web generate:api-types` regenerates `lib/api/schema.d.ts` without errors and the web build passes

## 6. Web app

- [x] 6.1 [standard] Send API requests to the same-origin `/api` base with credentials included, and handle 401, 403 and 429 in the playground with clear messages (sign-in prompt, live refresh needs sign-in, quota reached with time to reset); verified when lint and build pass and a manual check against the local stack shows each message
- [x] 6.2 [standard] Sign-in page with GitHub and ORCID buttons, sign-out, and account settings to link or unlink a provider; verified when lint and build pass and a manual sign-in through a test OAuth app works locally
- [x] 6.3 [standard] API-keys page for signed-in users: create (secret shown once with a copy action), list and revoke; verified when lint and build pass and a manually created key authenticates a `curl` call to `/api/select`
- [x] 6.4 [standard] Show remaining quota and reset time. For anonymous users, disable the "Fetch live catalog" toggle and render the Turnstile widget on resolve; verified when lint and build pass and a manual anonymous resolve succeeds with the toggle disabled

## 7. Deployment

- [ ] 7.1 [standard] `docker-compose.yml` and image changes:
  - add `postgres` and `gateway` services; the gateway image includes the web build and serves it at `/`
  - the `gateway` port is published on `127.0.0.1` only, for the existing reverse proxy
  - the `api` service publishes no port and keeps the shared secret
  - update `.env.example` with the new variables (including `TRUSTED_PROXIES`) and remove the Cloudflare Pages notes

  Verified when `docker compose up` brings the stack up locally, `http://127.0.0.1:<gateway port>/` serves the web app and `/api/health` answers
- [x] 7.2 [standard] VPS runbook (`docs/deploy-vps.md`) covering:
  - the reverse-proxy rule for the QRB host, with nginx and Traefik examples that set `X-Forwarded-For` and forward to the gateway's localhost port
  - firewall and SSH hardening, fail2ban, unattended upgrades
  - secrets file permissions
  - OAuth app registration for GitHub and ORCID
  - nightly off-VPS Postgres backups and how to restore one
  - the log-only rollout, then enforcement

  Verified when the README links it and every command in it is checked for syntax

## 8. Integration

- [x] 8.1 [standard] End-to-end check on the local compose stack:
  - an anonymous cached resolve succeeds
  - anonymous `force_refresh` gets 403
  - a script with no key gets 401
  - a key's usage counts toward its owner's quota
  - a direct call to FastAPI without the secret is refused
  - `task reproduce` still prints `6/6` and `105/105`

  Verified when each of these is observed and reported
- [x] 8.2 [light] Run `openspec validate add-auth-gateway --strict`, `uv run pytest -q` and `task gateway:test`; verified when all three pass and their final lines are reported. Light: runs listed commands, no judgment

## Workflow follow-up

- Ask whether a review is wanted before archiving.
- Archive the change so the `api-access-control` spec and the `http-api` changes land in `openspec/specs/`.
