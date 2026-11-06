/**
 * `GET /api/usage` (task 4.5): the caller's tier, daily quota, units used
 * today and time until reset. For a session (anonymous or signed in) or an API
 * key (which reports its owner's quota, shared with the browser session), or
 * a keyless caller (the quota shared at its IP address). Read-only: costs
 * nothing.
 *
 * Body: `{tier, quota, used, remaining, resetAt, secondsUntilReset}`.
 * `tier` is `anonymous` (keyless, per IP) or `signed_in`. `resetAt` is
 * ISO-8601 UTC (the next 00:00 UTC). `costs` (units per resolve, and per
 * request that fetches fresh provider data) and `burst` (requests per window
 * for this caller, and per API key for a signed-in user) describe the limits.
 */
import type { MiddlewareHandler } from "hono";
import { dailyUnitsUsed, utcDay } from "../db/counters";
import type { GatewayEnv } from "../forward";
import { nextUtcMidnight, secondsUntilReset, tierOf, type QuotaOptions } from "./quota";

export function usageHandler(opts: QuotaOptions): MiddlewareHandler<GatewayEnv> {
  const now = opts.now ?? (() => new Date());
  return async (c) => {
    const userId = c.get("userId");
    if (!userId) return c.json({ detail: "No identity for this request" }, 401);
    const db = await opts.getDb();
    const at = now();
    const day = utcDay(at);
    const tier = tierOf(c.get("isAnonymous"));
    const quota = opts.config.dailyUnits[tier];
    const used = await dailyUnitsUsed(db, "quota_user_daily", userId, day);
    const remaining = Math.max(0, quota - used);
    c.header("Cache-Control", "no-store");
    return c.json({
      tier,
      quota,
      used,
      remaining,
      resetAt: nextUtcMidnight(at).toISOString(),
      secondsUntilReset: secondsUntilReset(at),
      // What requests cost and how fast they may come, for the account page.
      costs: { resolve: 1, liveRefresh: opts.config.liveRefreshWeight },
      burst: {
        windowSeconds: opts.config.burst.windowSeconds,
        limit: opts.config.burst[tier],
        ...(tier === "signed_in" ? { apiKeyLimit: opts.config.burst.api_key } : {}),
      },
      // Keyless callers: what an account would get, for the website's sign-in prompt.
      ...(tier === "anonymous" ? { signedInQuota: opts.config.dailyUnits.signed_in } : {}),
    });
  };
}
