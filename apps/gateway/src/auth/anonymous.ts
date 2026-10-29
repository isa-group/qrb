/**
 * Anonymous identities (Better Auth's anonymous plugin).
 *
 * Creation: `ensureIdentity` gives a caller with no session an anonymous user
 * on the first request that needs one (resolve routes only). It calls
 * `auth.api.signInAnonymous` in-process, NOT the `/sign-in/anonymous` HTTP
 * route:
 * - Better Auth's rate limiter (sign-in: 3 per 10 s per IP) and
 *   `disabledPaths` run only in its HTTP router, so a server-side call is not
 *   limited. Many first-time visitors behind one IP (a lab, a university NAT)
 *   would otherwise be refused an identity. Abuse is bounded by the per-IP
 *   anonymous cap and CAPTCHA (tasks 4.3/4.4), which run before forwarding.
 * - The HTTP route itself is disabled (see `ANONYMOUS_DISABLED_PATHS`), so the
 *   only way to mint an identity is a resolve request that passed the
 *   gateway's earlier checks (e.g. `snapshot_path`).
 *
 * Linking: `onLinkAccount` (below) moves today's units from the anonymous user
 * to the account it signs in to. The plugin calls it after a sign-in or OAuth
 * callback that set a new session while an anonymous session was present,
 * then deletes the anonymous user.
 */
import type { Context, MiddlewareHandler, Next } from "hono";
import type { Database } from "../db";
import { moveDailyUnits, utcDay } from "../db/counters";
import type { GatewayEnv } from "../forward";
import type { GatewayAuth } from "./index";

/** The anonymous sign-in route is not public; identities come from `ensureIdentity`. */
export const ANONYMOUS_DISABLED_PATHS = ["/sign-in/anonymous"];

export const API_KEY_HEADER = "x-api-key";

/**
 * Whether the request authenticates with an API key. Such requests never get
 * an anonymous identity. Task 3.3 resolves the key into `userId`/`isAnonymous`
 * (and answers 401 for unknown or revoked keys) before `ensureIdentity` runs.
 */
export function hasApiKey(c: Context<GatewayEnv>): boolean {
  return c.req.header(API_KEY_HEADER) !== undefined;
}

/**
 * Runs after `sessionUser` on routes that need an identity. If the caller has
 * none (no valid session, no API key), creates an anonymous user and session,
 * sets `userId` and `isAnonymous` for this request, and adds the session
 * cookie to the response (whatever its status, so a retry reuses the
 * identity). Enforces nothing.
 */
export function ensureIdentity(getAuth: () => Promise<GatewayAuth>): MiddlewareHandler<GatewayEnv> {
  return async (c: Context<GatewayEnv>, next: Next) => {
    if (c.get("userId") || hasApiKey(c)) return next();

    const auth = await getAuth();
    // Errors (database down) propagate as 500: the request is not forwarded
    // without the identity the limits will need.
    const { headers, response } = await auth.api.signInAnonymous({
      headers: c.req.raw.headers,
      returnHeaders: true,
    });
    c.set("userId", response.user.id);
    c.set("isAnonymous", true);

    await next();

    const cookies = headers.getSetCookie();
    if (cookies.length === 0) return;
    // Copy: the downstream response's headers may be immutable.
    const out = new Headers(c.res.headers);
    for (const line of cookies) out.append("set-cookie", line);
    c.res = new Response(c.res.body, { status: c.res.status, statusText: c.res.statusText, headers: out });
  };
}

interface LinkAccountData {
  anonymousUser: { user: { id: string } };
  newUser: { user: { id: string; isAnonymous?: boolean | null } };
}

/**
 * The anonymous plugin's `onLinkAccount`: today's (UTC) units of the anonymous
 * user count toward the account it signed in to. Runs before the plugin
 * deletes the anonymous user. If it throws, the sign-in fails and the
 * anonymous user is kept, so no usage is lost.
 */
export function carryOverAnonymousUsage(db: Database, now: () => Date = () => new Date()) {
  return async ({ anonymousUser, newUser }: LinkAccountData): Promise<void> => {
    const from = anonymousUser.user.id;
    const to = newUser.user.id;
    // The plugin skips deletion in these cases; keep the usage where it is.
    if (from === to || newUser.user.isAnonymous) return;
    await moveDailyUnits(db, from, to, utcDay(now()));
  };
}
