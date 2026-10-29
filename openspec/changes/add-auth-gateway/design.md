# Design

## Context

See proposal.md (Why). Relevant current state:

- `apps/api` (FastAPI, ~400 lines) is a thin shell over the Python `qrb`
  library. The real work (OpenQASM 3 parsing, Qiskit transpilation, IBM and
  Braket SDKs, calibration, BIM assembly) has no TypeScript equivalent.
- `apps/web` is a static Next.js export deployed to Cloudflare Pages, so it
  cannot host server-side auth.
- The browser calls the Python API directly with CORS. The typed web client
  (`apps/web/lib/api/schema.d.ts`) is generated from FastAPI's OpenAPI.
- Postgres is optional today (`DATABASE_URL`, `packages/qrb-store`), and
  `docker-compose.yml` has no Postgres service.
- The CLI and the artifact reproduction never call the API.

## Goals / Non-Goals

**Goals:**
- Identify every caller of resolve routes and cap what each can spend.
- Keep the public API paths and response bodies the web app already uses.
- Keep the Python API unchanged except where the http-api delta requires it.

**Non-Goals:**
- Porting any `qrb` logic to TypeScript.
- Paid tiers, organization or team quotas, or billing.
- Changing the CLI or the artifact reproduction.

## Decisions

### Gateway in front of a private Python API
A TypeScript gateway is the only public service, and it forwards to FastAPI
on the private network.
- Rejected: replacing FastAPI with a TypeScript API. Qiskit and the provider
  SDKs are Python-only.
- Rejected: shelling out to Python per request. Each request would pay
  Qiskit's import time, and the in-process 90 s catalog cache and startup
  warm-up would stop working.

### Hono on Bun, not NestJS
The gateway handles auth, limits, input checks and forwarding; business logic
stays in Python.
- Hono is small and Better Auth documents it as a first-class integration.
- Bun is already the repo's JavaScript toolchain.
- NestJS's modules and DI pay off only if real product logic moves to
  TypeScript, which is out of scope.

### Better Auth for identity
Better Auth provides accounts, sessions, and (via plugins) anonymous users,
API keys and CAPTCHA verification. The plugin set is anonymous, API key and
captcha.
Exact plugin options must be checked against Better Auth's current
documentation when implementing. In particular:
- whether its API-key plugin's per-key rate limiting can serve the per-key
  burst limit;
- whether its anonymous plugin's account-linking hook can carry usage over.

### Sign-in with GitHub and ORCID only
- Accounts are created only through GitHub OAuth or ORCID OAuth. ORCID uses
  Better Auth's generic OAuth support.
- There is no email or password sign-in.
- Why:
  - nothing to run for sending email;
  - no password hashes, reset flow or 2FA to maintain;
  - throwaway accounts are much harder to create than with email sign-up,
    which matters because signing in multiplies the quota.
- Rejected: an email and password tier with a small quota bump, playground
  only. It would need an SMTP relay for verification and password resets,
  plus CAPTCHA on every resolve to stay browser-only, and the users it would
  serve (no GitHub and no ORCID) are expected to be few. It can be added
  later.
- Account merging:
  - A sign-in whose provider reports a **verified** email matching an
    existing account's email is linked to that account.
  - Users can also link or unlink a provider by hand while signed in.
  - Merging on an unverified email is refused. Otherwise anyone who adds a
    victim's address to a new GitHub or ORCID account could take over the
    victim's QRB account.
  - GitHub reports email verification. ORCID often returns no email, because
    users can make it private, so ORCID sign-ins frequently create a
    separate account that the user can link by hand.
  - Better Auth's account-linking settings (trusted providers and the
    verified-email requirement) must be checked against its docs, so that
    linking never happens on an unverified email.
- Every signed-in user has a GitHub or ORCID identity, so every signed-in
  user may create API keys.

### Quotas are counted per user, by the gateway
Better Auth's per-key "remaining" counter cannot express a quota shared by
all of a user's keys and their browser session.
- The gateway keeps its own daily counters in Postgres, keyed by user and UTC
  day, plus a per-IP counter for anonymous use.
- The counter is checked before forwarding and committed only when the
  forwarded call does not fail with 5xx.
- Burst limits use a sliding window in the same store, so they work across
  several gateway instances.
- Rejected: an in-memory limiter. It resets on deploy and does not work with
  more than one instance.

### Gateway-to-API trust
- The Python API binds to the private network only, and requires an
  `X-QRB-Gateway-Secret` header matching a shared secret from the
  environment.
- The gateway strips any client-sent copy of that header.
- The gateway passes the caller's user id in a header for logging. The
  Python API does not make access decisions.

### Input hardening in the Python API, not only the gateway
- The `snapshot_path` rejection and the text-only `circuit_qasm` parsing (see
  the http-api delta) are implemented in FastAPI.
- The gateway also rejects `snapshot_path`, so the request fails fast.
- Putting the fix in Python keeps it in force even if the API were ever
  exposed directly again.

### Typed client generated from the gateway
- The gateway publishes one OpenAPI schema: the Python API's paths, plus the
  auth, API-key and usage routes, plus the new 401/403/429 responses.
- The web app's `generate-api-types` script reads that schema instead of
  FastAPI's.
- The `/scalar` reference is served by the gateway.

### Single VPS, single origin
Everything runs on one VPS behind the reverse proxy that already runs there
(for example nginx or Traefik), and the web app moves off Cloudflare Pages.
The gateway is the only process the proxy talks to:

```
  internet --> :443 existing reverse proxy (TLS)
                 |  all paths, X-Forwarded-For
                 v
               gateway (localhost)
                 /        -> static web files (apps/web/out)
                 /api/*   -> auth, limits, forwarding
                               |-> FastAPI  (localhost, shared secret)
                               |-> Postgres (localhost)
```

- QRB adds no proxy of its own. The deployment needs one proxy rule:
  forward the QRB host to the gateway's localhost port. The runbook gives
  examples for nginx and Traefik.
- The gateway serves the static web build itself, so the web app and the API
  share one origin without any path routing in the proxy.
- Client IP: the gateway reads `X-Forwarded-For` only when the connection
  comes from an address in `TRUSTED_PROXIES` (default `127.0.0.1` and
  `::1`). From any other address it uses the socket's remote address and
  ignores the header. It takes the right-most entry that is not itself a
  trusted proxy. The per-IP cap and burst limits depend on this.
- Rejected:
  - adding Caddy, since a proxy already exists;
  - terminating TLS in the gateway, which would mean taking over certificate
    renewal from the existing proxy.

- The browser and the API share one origin, so production needs no CORS and
  session cookies are `HttpOnly`, `Secure` and `SameSite=Lax`.
- `WEB_ORIGINS` remains for local development (web on `:3000`, gateway on
  another port).
- Rejected: keeping Cloudflare Pages on a sibling subdomain. It works, but it
  adds a second deployment target and needs cross-origin cookie
  configuration for no gain.
- Postgres also holds the rate-limit and quota counters, so no Redis is
  needed on a single instance.

### VPS hardening
- Firewall: only 22, 80 and 443 are open.
- The gateway, FastAPI and Postgres bind to localhost or a private Docker
  network only.
- SSH is key-only, with fail2ban and unattended security upgrades.
- Secrets live in an env file readable only by root:
  - OAuth client secrets
  - Better Auth secret
  - gateway shared secret
  - provider credentials
  - CAPTCHA secret
- Postgres is backed up nightly to storage off the VPS, since it now holds
  user accounts.
- Better Auth's own rate limiter (for sign-in routes) uses Postgres storage,
  so limits survive restarts.

### Proposed default limits (configurable)

| | Anonymous | Signed in | API key |
|---|---|---|---|
| Daily resolve units | 10 per user, 30 per IP | 200 | Shares owner's 200 |
| Live refresh cost | not allowed | 5 units | 5 units |
| Burst | 3 per minute | 20 per minute | 20 per minute per key |
| CAPTCHA on resolve | yes | no | no |

## Risks / Trade-offs

- [The extra network hop adds latency] → Small next to the 40-50 s live
  catalog fetch and the solver call. The gateway streams bodies through
  without re-parsing them.
- [Postgres becomes a hard dependency of the public deployment] → Add a
  Postgres service to `docker-compose.yml`. The CLI and the library keep
  working without it.
- [Anonymous abuse through rotating IPs] → The CAPTCHA, the low per-IP cap
  and cached-only resolves bound the cost of each request. Revisit if abuse
  appears.
- [Shared-IP users (labs, universities) hit the anonymous per-IP cap
  together] → They can sign in, and the cap is configurable.
- [Better Auth plugin behavior differs from the assumptions above] →
  Implement quotas in the gateway's own store, not in plugin counters, so
  only key management and identity depend on plugins.
- [One VPS is a single point of failure for the web app, the API and user
  accounts] → Nightly off-VPS Postgres backups and a documented rebuild from
  `docker-compose.yml`. Downtime is acceptable for a research service.
- [GitHub or ORCID outages block sign-in] → Existing sessions and API keys
  keep working. Anonymous playground use is unaffected.
- [Email merging trusts the provider's verification] → Merge only when the
  provider marks the email verified, and never treat ORCID as verifying an
  email it does not return. Tests cover the unverified and missing cases.
- [Users without a GitHub or ORCID account cannot sign in] → They keep
  anonymous playground use. Email sign-in can be added later as its own
  change.

## Migration Plan

1. Set up the VPS: firewall, Postgres, backups, and a proxy rule on the
   existing reverse proxy forwarding the QRB host to the gateway. Register
   the GitHub and ORCID OAuth apps with the VPS domain as the callback URL.
2. Deploy the gateway (serving the web build) and FastAPI behind the
   existing proxy, with limits in log-only mode.
3. Point DNS at the VPS and retire the Cloudflare Pages site.
4. Make the Python API private, require the shared secret, and remove its
   public CORS.
5. Turn on enforcement (401/403/429).
6. Rollback: switch the gateway to log-only mode. To roll back the hosting
   move, re-publish the static build to Cloudflare Pages pointed at the
   gateway's public URL. That needs `WEB_ORIGINS` and cross-origin cookies,
   so it is a fallback, not a target.

## Open Questions

- CAPTCHA provider: Cloudflare Turnstile is the default assumption. It works
  on any host, not only Cloudflare Pages.
- Final quota numbers.
- Whether the binding log should store the user id. That would be a
  history-persistence change.
