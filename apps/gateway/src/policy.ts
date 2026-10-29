/**
 * Route policy (task 4.2).
 *
 * - Open routes (health, catalog, presets, engines, API reference) need no
 *   identity and never create one. Each starts with `openRoute`, their
 *   per-IP rate limit (`openRouteLimit` in `limits/burst.ts`, task 4.3).
 * - Resolve routes (`POST /select`, `/instance`) need an identity (`requireIdentity`).
 *   A caller with a session or API key has one. A caller with neither gets an
 *   anonymous identity (`ensureIdentity`) ONLY if the request carries a CAPTCHA
 *   token in the `X-Captcha-Token` header, i.e. it comes from the web app's
 *   widget; otherwise 401. Task 4.4 verifies the token against Turnstile; until
 *   then only its presence is checked, which separates "browser flow" from
 *   "script that forgot its key" but is not a security boundary by itself.
 * - Anonymous or unidentified requests whose effective `force_refresh` is true
 *   get 403 (`requireSignInForLiveRefresh`). Mounted before `quota`, so they
 *   are never counted, and before identity creation, so they create nothing.
 */
import type { MiddlewareHandler } from "hono";
import { hasApiKey } from "./auth/anonymous";
import type { GatewayEnv } from "./forward";
import { effectiveForceRefresh } from "./limits/quota";

export const CAPTCHA_HEADER = "x-captcha-token";

/** The CAPTCHA token a request carries, if any (non-blank). */
export function captchaToken(c: { req: { header(name: string): string | undefined } }): string | undefined {
  const v = c.req.header(CAPTCHA_HEADER)?.trim();
  return v ? v : undefined;
}

/** 401 unless the caller has an identity (session, API key) or may be given an anonymous one (CAPTCHA token). */
export const requireIdentity: MiddlewareHandler<GatewayEnv> = async (c, next) => {
  if (c.get("userId") || hasApiKey(c) || captchaToken(c)) return next();
  return c.json({ detail: "Authentication required: sign in, send an API key in x-api-key, or use the web app" }, 401);
};

/** 403 for anonymous or unidentified requests that would trigger a live refresh. */
export const requireSignInForLiveRefresh: MiddlewareHandler<GatewayEnv> = async (c, next) => {
  if (c.get("isAnonymous") !== false && effectiveForceRefresh(c)) {
    return c.json({ detail: "Live refresh requires sign-in" }, 403);
  }
  return next();
};
