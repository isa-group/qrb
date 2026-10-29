/**
 * Credentialed CORS for the API (http-api "Cross-origin access").
 *
 * Only for local development, where the web dev server (:3000) and the gateway
 * are different origins: origins in `WEB_ORIGINS` (comma-separated, default
 * `http://localhost:3000,http://localhost:3002`) may call `/api/*` with
 * cookies. In production web and API share one origin, so CORS is OFF
 * (no origin is allowed), consistent with Better Auth's trusted origins, which
 * also ignore `WEB_ORIGINS` there (`./auth/config.ts`).
 *
 * Matching is exact on the origin string. An allowed origin gets
 * `Access-Control-Allow-Origin: <that origin>` (never `*`),
 * `Access-Control-Allow-Credentials: true` and the quota headers exposed;
 * any other origin gets no CORS headers at all. Mounted before everything
 * else on `/api/*`, a preflight from an allowed origin is answered here with
 * 204 and never reaches identity, limits or the upstream, so it consumes
 * nothing.
 */
import type { MiddlewareHandler } from "hono";
import { QUOTA_HEADERS } from "./limits/quota";

export const DEFAULT_WEB_ORIGINS = ["http://localhost:3000", "http://localhost:3002"] as const;

const ALLOW_METHODS = "GET,POST,DELETE,OPTIONS";
const ALLOW_HEADERS = "content-type,x-api-key,x-captcha-token";
const EXPOSE_HEADERS = [...QUOTA_HEADERS, "Retry-After"].join(",");
/** Seconds a browser may cache a preflight answer. */
const PREFLIGHT_MAX_AGE = "600";

function normalize(origin: string): string {
  const o = origin.trim();
  try {
    return new URL(o).origin;
  } catch {
    return o.replace(/\/+$/, "");
  }
}

/** Origins allowed credentialed access: none in production, else `WEB_ORIGINS` (or the defaults). */
export function webOriginsFromEnv(env: Record<string, string | undefined> = process.env): string[] {
  if (env.NODE_ENV === "production") return [];
  const listed = (env.WEB_ORIGINS ?? "")
    .split(",")
    .map(normalize)
    .filter(Boolean);
  return [...new Set(listed.length ? listed : DEFAULT_WEB_ORIGINS)];
}

export function credentialedCors(origins: readonly string[]): MiddlewareHandler {
  const allowed = new Set(origins);
  return async (c, next) => {
    if (allowed.size === 0) return next();
    const origin = c.req.header("origin");
    if (!origin || !allowed.has(origin)) {
      await next();
      c.header("Vary", "Origin", { append: true });
      return;
    }

    if (c.req.method === "OPTIONS" && c.req.header("access-control-request-method")) {
      c.header("Vary", "Origin", { append: true });
      c.header("Access-Control-Allow-Origin", origin);
      c.header("Access-Control-Allow-Credentials", "true");
      c.header("Access-Control-Allow-Methods", ALLOW_METHODS);
      c.header("Access-Control-Allow-Headers", ALLOW_HEADERS);
      c.header("Access-Control-Max-Age", PREFLIGHT_MAX_AGE);
      return c.body(null, 204);
    }
    // After the handler: handlers that return a fresh Response (Better Auth,
    // the upstream proxy) would otherwise drop headers set before `next()`.
    await next();
    c.header("Vary", "Origin", { append: true });
    c.header("Access-Control-Allow-Origin", origin);
    c.header("Access-Control-Allow-Credentials", "true");
    c.header("Access-Control-Expose-Headers", EXPOSE_HEADERS);
  };
}
