import { Hono } from "hono";
import { readJsonBody } from "./body";
import { createForward, createUpstream, type ForwardOptions, type GatewayEnv } from "./forward";
import { bindRoutes } from "./binds";
import { AUTH_BASE_PATH, KEYS_PATH, authGetter, authHandler, identifyByIp, keyRoutes, sessionUser, withApiKey, type AuthSource } from "./auth";
import { authFromEnv } from "./auth/from-env";
import type { Database } from "./db";
import { limitsConfig, limitsConfigFromEnv, type LimitsOverrides } from "./limits/config";
import { burstLimit, openRouteLimit } from "./limits/burst";
import { enforceQuota } from "./limits/quota";
import { clientIp, trustedProxiesFromEnv, type ClientAddress } from "./client-ip";
import { credentialedCors, webOriginsFromEnv } from "./cors";
import { usageHandler } from "./limits/usage";
import { activityRoutes, recordActivity } from "./activity";
import { recordMetrics } from "./metrics";
import { adminUserIdsFromEnv, mountAdmin } from "./admin";

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
  /** Admins by user id regardless of role. Defaults to `QRB_ADMIN_USER_IDS`; pass the same list to the auth config. */
  adminUserIds?: readonly string[];
}

/**
 * The gateway: the only public entry to the Python API, mounted at `/api/*`.
 *
 * Who is calling (in this order): an API key (`x-api-key`, its owner), a
 * signed-in session (GitHub or ORCID), else the client IP (`ip:<address>`).
 * Nothing requires sign-in: the website calls the API without a key and is
 * limited per IP address; a key gives its owner a larger quota of their own.
 *
 * Costs: a resolve (`POST /select`, `/instance`) costs 1 unit, or the
 * live-refresh weight when it fetches fresh provider data (`force_refresh`,
 * true by default there). Catalog reads are free on the 90 s cache and cost
 * the weight with `force_refresh=true`. Counted requests also pass a burst
 * limit; every open route has a per-IP rate limit.
 */
export function createApp(opts: AppOptions = {}) {
  const app = new Hono<GatewayEnv>();
  const getAuth = authGetter(opts.auth ?? authFromEnv());

  // Metrics first, so they see every final status (preflights, 401s, 429s, 5xx).
  app.use("/api/*", recordMetrics());

  // CORS before everything else: a preflight is answered here and consumes nothing.
  app.use("/api/*", credentialedCors(opts.webOrigins ?? webOriginsFromEnv()));

  // Client IP next, for every API route (identity, limits and Better Auth's limiter).
  app.use("/api/*", clientIp({ trustedProxies: opts.trustedProxies ?? trustedProxiesFromEnv(), clientAddress: opts.clientAddress }));

  const getDb = opts.db ? async () => opts.db! : async () => (await getAuth()).options.database.db as Database;
  const config = opts.limits ? limitsConfig(opts.limits) : limitsConfigFromEnv();
  const limitOpts = { getDb, config, now: opts.now };
  const openRoute = openRouteLimit(limitOpts);

  app.get("/api/health", openRoute, (c) => c.json({ status: "ok" }));

  // Better Auth: sign-in (GitHub, ORCID), callbacks, session, link/unlink.
  app.on(["GET", "POST"], `${AUTH_BASE_PATH}/*`, authHandler(getAuth));

  // Identity: `withKey` (API key, replaces any session identity; 401 if invalid)
  // after `withUser` (session), then `byIp` for callers with neither. `burst` and
  // `quota` go right before `forward` (`quota` last, so requests rejected before
  // forwarding are never charged).
  const withUser = sessionUser(getAuth);
  const withKey = withApiKey(getAuth);
  const upstream = createUpstream(opts);
  const forward = createForward(opts, upstream);
  const body = readJsonBody();
  const quota = enforceQuota(limitOpts);
  const burst = burstLimit(limitOpts);
  const identify = [withUser, withKey, identifyByIp] as const;
  // Signed-in users' counted requests and binds, for the Account page (after identity, before
  // burst and quota so it sees their 429s and the final cost).
  const activity = recordActivity(limitOpts);

  // API key management for signed-in users.
  const keys = keyRoutes(getAuth);
  app.post(KEYS_PATH, withUser, keys.guard, keys.create);
  app.get(KEYS_PATH, withUser, keys.guard, keys.list);
  app.delete(`${KEYS_PATH}/:id`, withUser, keys.guard, keys.revoke);

  // The caller's own quota. Costs nothing.
  app.get("/api/usage", openRoute, ...identify, usageHandler(limitOpts));

  // Account activity (session only): daily units by source, the request log, the bind history.
  const act = activityRoutes({ getDb, now: opts.now });
  app.get("/api/usage/daily", openRoute, withUser, act.guard, act.daily);
  app.get("/api/history/requests", openRoute, withUser, act.guard, act.requests);
  app.get("/api/history/binds", openRoute, withUser, act.guard, act.binds);
  app.delete("/api/history/binds", openRoute, withUser, act.guard, act.removeAll);
  app.get("/api/history/binds/:id", openRoute, withUser, act.guard, act.bind);
  app.delete("/api/history/binds/:id", openRoute, withUser, act.guard, act.removeOne);

  // Admin (signed-in session only, admins only; see `admin.ts`).
  mountAdmin(app, [openRoute, withUser], {
    getAuth,
    getDb,
    adminUserIds: opts.adminUserIds ?? adminUserIdsFromEnv(),
    trustedOrigins: async () => {
      const origins = (await getAuth()).options.trustedOrigins;
      return Array.isArray(origins) ? origins : [];
    },
    now: opts.now,
  });

  // Resolve: 413 for an oversized body, 401 for an invalid key, then burst and quota (429).
  const resolve = [body, ...identify, activity, burst, quota, forward] as const;
  app.post("/api/select", ...resolve);
  app.post("/api/instance", ...resolve);

  // Async binds (accounts only): the `/select` body, 202 with an id, resolved in the background and
  // polled with GET. Charged like `/select`; a failed upstream refunds. See `binds.ts`.
  const asyncBinds = bindRoutes({ getDb, upstream, now: opts.now });
  app.post("/api/binds", body, ...identify, asyncBinds.guard, asyncBinds.validate, activity, asyncBinds.pendingCap, burst, quota, asyncBinds.submit);
  app.get("/api/binds/:id", openRoute, ...identify, asyncBinds.guard, asyncBinds.get);

  // Catalog reads: per-IP limit on every call; burst and quota only on a live refresh.
  const catalog = [openRoute, ...identify, activity, burst, quota, forward] as const;
  app.get("/api/catalog", ...catalog);
  app.get("/api/catalog/:candidate_id", ...catalog);
  app.get("/api/catalog/:candidate_id/topology", ...catalog);

  // Free and uncounted; a session or key is resolved only so the API can log who asked.
  app.get("/api/engines", openRoute, withUser, withKey, forward);
  app.get("/api/presets", openRoute, withUser, withKey, forward);
  app.get("/api/features", openRoute, withUser, withKey, forward);
  // The API's OpenAPI document (the website's /docs renders the same spec).
  app.get("/api/openapi.json", openRoute, forward);

  return app;
}

export const app = createApp();

export default app;
