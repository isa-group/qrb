# Proposal

## Original request

> i want to migrate the api to nestjs

> i want better auth (the library) for auth, get rate limits quotas etc etc

## Why

The QRB API is fully open. Every `POST /select` forces a live IBM Quantum and
Amazon Braket catalog fetch with the operator's credentials and calls the
public OpenBinding gateway, so any caller can spend upstream quota without
limit. The API also reads arbitrary server-side files through
`snapshot_path` and `circuit_qasm`. Better Auth (a TypeScript library) cannot
run in the Python API or in the static web export, so access control needs a
TypeScript service in front of the Python one.

## What Changes

- Add a TypeScript gateway (Hono on Bun) as the only public entry point. It
  serves the existing public API paths unchanged, plus sign-in and API-key
  routes, and forwards QRB requests to the Python API.
- **BREAKING (deployment):** the Python API becomes internal only. It is no
  longer published to browsers and rejects requests that lack the gateway's
  shared secret.
- Identities via Better Auth: anonymous browser users (created automatically,
  linkable to an account on sign-up), signed-in users, and API keys owned by
  users.
- Sign-up and sign-in only with GitHub or ORCID OAuth; there is no email or
  password sign-in. Accounts with the same provider-verified email are
  merged, and users can link or unlink a provider by hand.
- Usage limits: per-user daily quotas on resolves (API keys draw from their
  owner's quota), live catalog refreshes counted more heavily, per-identity
  and per-key burst limits, a per-IP cap and a CAPTCHA for anonymous use.
  Anonymous users get the cached catalog only.
- **BREAKING (API):** `snapshot_path` is no longer accepted on public
  requests, and `circuit_qasm` is always parsed as OpenQASM 3 text, never as
  a file path.
- The web app gains sign-in, API-key management and quota display, and sends
  credentials with its requests.
- Postgres becomes required for the public deployment (auth tables and usage
  counters).
- **BREAKING (deployment):** everything moves to a single VPS and the web app
  leaves Cloudflare Pages. The VPS's existing reverse proxy terminates TLS
  and forwards to the gateway, which serves both the static web build and
  the API from one origin. QRB adds no proxy of its own.

NestJS was considered and set aside: the gateway mostly does auth, limits and
forwarding, which Hono covers with far less structure. See design.md.

## Capabilities

### New Capabilities

- `api-access-control`: who may call the public API, how callers are
  identified (anonymous, signed-in, API key), and the quotas, rate limits and
  abuse controls applied to each.

### Modified Capabilities

- `http-api`: public requests no longer accept `snapshot_path`;
  `circuit_qasm` is always treated as source text; cross-origin access moves
  to the gateway and allows credentials.

## Impact

- New `apps/gateway` (TypeScript, Hono, Better Auth), which also serves the
  web build, with its Docker image and compose service; a Postgres service
  for deployments.
- VPS: one proxy rule on the existing reverse proxy, GitHub and ORCID OAuth
  app registrations, firewall and SSH hardening, and nightly off-VPS Postgres
  backups. Cloudflare Pages is retired.
- `apps/api`: internal-only binding, shared-secret check, `snapshot_path` and
  file-path circuit handling removed from the public request path.
- `apps/web`: sign-in, API keys, quota display, credentialed requests, new
  401/403/429 handling; the typed API client is generated from the gateway's
  OpenAPI schema instead of FastAPI's.
- Unchanged: the CLI (calls the library directly), the `qrb` library,
  OpenBinding, and the artifact reproduction (`task reproduce` never uses the
  API).
- Out of scope: paid tiers, organization or team quotas, and a CLI mode that
  calls the hosted API with an API key.
