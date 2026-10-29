import { Hono } from "hono";
import { rejectSnapshotPath } from "./snapshot-path";
import { createForward, type ForwardOptions, type GatewayEnv } from "./forward";
import { AUTH_BASE_PATH, KEYS_PATH, authGetter, authHandler, ensureIdentity, keyRoutes, sessionUser, withApiKey, type AuthSource } from "./auth";
import { authFromEnv } from "./auth/from-env";
import type { Database } from "./db";
import { limitsConfig, limitsConfigFromEnv, type LimitsOverrides } from "./limits/config";
import { burstLimit, openRouteLimit } from "./limits/burst";
import { anonymousIpGate, enforceQuota } from "./limits/quota";
import { clientIp, trustedProxiesFromEnv, type ClientAddress } from "./client-ip";
import { requireIdentity, requireSignInForLiveRefresh } from "./policy";
import { captchaFromEnv, verifyCaptcha, type CaptchaVerifier } from "./captcha";
import { credentialedCors, webOriginsFromEnv } from "./cors";
import { usageHandler } from "./limits/usage";
import { OPENAPI_PATH, SCALAR_PATH, buildOpenApi, scalarHtml } from "./openapi";

export interface AppOptions extends ForwardOptions {
  /** Better Auth instance (or async factory). Defaults to one built from the environment. */
  auth?: AuthSource;
  /** Database for the quota counters. Defaults to the auth instance's database (one pool for both). */
  db?: Database;
  /** Overrides of the default limits (`DEFAULT_LIMITS`). When omitted, limits come from the environment (`limitsConfigFromEnv`). */
  limits?: LimitsOverrides;
  /** Clock for the quota day and the burst windows, injectable for tests. */
  now?: () => Date;
  /** Proxies whose `X-Forwarded-For` is honoured (IPs or CIDRs). Defaults to `TRUSTED_PROXIES` or 127.0.0.1, ::1. */
  trustedProxies?: readonly string[];
  /** Socket remote address of a request. Defaults to Bun's `server.requestIP`; injectable for tests. */
  clientAddress?: ClientAddress;
  /** Origins allowed credentialed cross-origin access. Defaults to `WEB_ORIGINS` (dev only; none in production). */
  webOrigins?: readonly string[];
  /** CAPTCHA verifier for anonymous resolves. Defaults to Turnstile from `TURNSTILE_SECRET_KEY` (throws in production without it). Tests inject a stub. */
  captcha?: CaptchaVerifier;
}

export function createApp(opts: AppOptions = {}) {
  const app = new Hono<GatewayEnv>();
  const getAuth = authGetter(opts.auth ?? authFromEnv());

  // CORS before everything else: a preflight is answered here and consumes nothing.
  app.use("/api/*", credentialedCors(opts.webOrigins ?? webOriginsFromEnv()));

  // Client IP next, for every API route (limits and Better Auth's limiter).
  app.use("/api/*", clientIp({ trustedProxies: opts.trustedProxies ?? trustedProxiesFromEnv(), clientAddress: opts.clientAddress }));

  const getDb = opts.db ? async () => opts.db! : async () => (await getAuth()).options.database.db as Database;
  const captcha = verifyCaptcha(opts.captcha ?? captchaFromEnv());
  const config = opts.limits ? limitsConfig(opts.limits) : limitsConfigFromEnv();
  const limitOpts = { getDb, config, now: opts.now };
  const openRoute = openRouteLimit(limitOpts);

  app.get("/api/health", openRoute, (c) => c.json({ status: "ok" }));

  // API reference: the merged OpenAPI document and its Scalar page. Open routes.
  const openApiDoc = buildOpenApi();
  app.get(OPENAPI_PATH, openRoute, (c) => c.json(openApiDoc));
  app.get(SCALAR_PATH, openRoute, (c) => c.html(scalarHtml()));

  // Better Auth: sign-in (GitHub, ORCID), callbacks, session, link/unlink.
  app.on(["GET", "POST"], `${AUTH_BASE_PATH}/*`, authHandler(getAuth));

  // Resolves the session user into `userId` (forwarded for logging) and
  // `isAnonymous`. Resolve routes also get an anonymous identity if the caller
  // has none (after input checks, so rejected requests create nothing). `withKey`
  // (API key, which replaces any session identity) goes before `withIdentity`.
  // `ipGate` (per-IP anonymous cap, read-only) goes before `withIdentity` so a
  // capped IP mints no identities; `burst` and `quota` go between `withIdentity`
  // and `forward` (`quota` last, so requests rejected before forwarding are
  // never charged). Open routes never create identities.
  const withUser = sessionUser(getAuth);
  const withKey = withApiKey(getAuth);
  const withIdentity = ensureIdentity(getAuth);
  const forward = createForward(opts);
  const noSnapshotPath = rejectSnapshotPath();
  const quota = enforceQuota(limitOpts);
  const burst = burstLimit(limitOpts);
  const ipGate = anonymousIpGate(limitOpts);

  // API key management for signed-in (non-anonymous) users.
  const keys = keyRoutes(getAuth);
  app.post(KEYS_PATH, withUser, keys.guard, keys.create);
  app.get(KEYS_PATH, withUser, keys.guard, keys.list);
  app.delete(`${KEYS_PATH}/:id`, withUser, keys.guard, keys.revoke);

  // Usage of the caller's own quota: session (anonymous or signed in) or API key.
  // 401 without identity; creates nothing and costs nothing.
  app.get("/api/usage", openRoute, withUser, withKey, usageHandler(limitOpts));

  // Resolve: 401 without identity (or CAPTCHA token), 403 for a missing/invalid CAPTCHA
  // token on an anonymous request (before anything is created or counted), 403 for anonymous live refresh,
  // 429 for a capped IP (before identity creation), then identity, burst, quota.
  const resolveChain = [noSnapshotPath, withUser, withKey, requireIdentity, captcha, requireSignInForLiveRefresh, ipGate, withIdentity, burst, quota, forward] as const;
  app.post("/api/select", ...resolveChain);
  app.post("/api/instance", ...resolveChain);
  // Catalog reads are open; a live refresh needs sign-in and costs units (`quota`).
  // Per-IP limit on every call; the identity/key burst only on those that cost units.
  app.get("/api/catalog", openRoute, withUser, withKey, requireSignInForLiveRefresh, burst, quota, forward);
  app.get("/api/catalog/:candidate_id", openRoute, withUser, withKey, requireSignInForLiveRefresh, burst, quota, forward);
  app.get("/api/engines", openRoute, withUser, withKey, forward);
  app.get("/api/presets", openRoute, withUser, withKey, forward);

  return app;
}

export const app = createApp();

export default app;
