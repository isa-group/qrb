/**
 * Callers without an account: identified by their client IP.
 *
 * The web app calls the API without signing in and without a CAPTCHA, so a
 * request with no valid session and no API key is charged to the identity
 * `ip:<client IP>` (IPv6 bucketed by /64, see `../client-ip.ts`) on the
 * `anonymous` tier. Every keyless caller behind one address shares that
 * budget; clearing cookies or rotating anything but the address does not
 * reset it. Nothing is written to the auth tables: no user, no session, no
 * cookie.
 *
 * Signing in (GitHub or ORCID) and creating an API key gives a caller its own
 * `signed_in` budget.
 */
import type { Context, MiddlewareHandler, Next } from "hono";
import { UNKNOWN_CLIENT } from "../client-ip";
import type { GatewayEnv } from "../forward";

export const API_KEY_HEADER = "x-api-key";

/** Prefix of the identities given to keyless callers. Better Auth ids never contain `:`. */
export const IP_IDENTITY_PREFIX = "ip:";

/** Whether the request authenticates with an API key (`withApiKey` verifies it). */
export function hasApiKey(c: Context<GatewayEnv>): boolean {
  return c.req.header(API_KEY_HEADER) !== undefined;
}

/** The identity of a keyless caller at `clientIp`. */
export function ipIdentity(clientIp: string | undefined): string {
  return IP_IDENTITY_PREFIX + (clientIp ?? UNKNOWN_CLIENT);
}

/**
 * Runs after `sessionUser` and `withApiKey`. A caller with neither gets
 * `userId = ip:<client IP>` and `isAnonymous = true`. Enforces nothing.
 */
export const identifyByIp: MiddlewareHandler<GatewayEnv> = async (c: Context<GatewayEnv>, next: Next) => {
  if (!c.get("userId")) {
    c.set("userId", ipIdentity(c.get("clientIp")));
    c.set("isAnonymous", true);
  }
  return next();
};
