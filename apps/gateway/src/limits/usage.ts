/**
 * `GET /api/usage` (task 4.5): the caller's tier, daily quota, units used
 * today and time until reset. For a session (anonymous or signed in) or an API
 * key (which reports its owner's quota, shared with the browser session).
 * Read-only: costs nothing, creates no identity, 401 without one.
 *
 * Body: `{tier, quota, used, remaining, resetAt, secondsUntilReset}`.
 * `tier` is `anonymous` or `signed_in`. `used` and `quota` are the user's own
 * counter. `resetAt` is ISO-8601 UTC (the next 00:00 UTC). Anonymous callers
 * also get `ip: {quota, used, remaining}` (the cap shared by all anonymous
 * users at their IP) and their `remaining` is the smaller of the two
 * remainders, matching the `X-Quota-Remaining` header of counted requests.
 */
import type { MiddlewareHandler } from "hono";
import { UNKNOWN_CLIENT } from "../client-ip";
import { dailyUnitsUsed, utcDay } from "../db/counters";
import type { GatewayEnv } from "../forward";
import { nextUtcMidnight, secondsUntilReset, tierOf, type QuotaOptions } from "./quota";

export function usageHandler(opts: QuotaOptions): MiddlewareHandler<GatewayEnv> {
  const now = opts.now ?? (() => new Date());
  return async (c) => {
    const userId = c.get("userId");
    if (!userId) return c.json({ detail: "Authentication required: sign in or send an API key in x-api-key" }, 401);
    const db = await opts.getDb();
    const at = now();
    const day = utcDay(at);
    const tier = tierOf(c.get("isAnonymous"));
    const quota = opts.config.dailyUnits[tier];
    const used = await dailyUnitsUsed(db, "quota_user_daily", userId, day);
    let remaining = Math.max(0, quota - used);
    let ip: { quota: number; used: number; remaining: number } | undefined;
    if (tier === "anonymous") {
      const cap = opts.config.anonymousIpDailyUnits;
      const ipUsed = await dailyUnitsUsed(db, "quota_ip_daily", c.get("clientIp") ?? UNKNOWN_CLIENT, day);
      ip = { quota: cap, used: ipUsed, remaining: Math.max(0, cap - ipUsed) };
      remaining = Math.min(remaining, ip.remaining);
    }
    c.header("Cache-Control", "no-store");
    return c.json({
      tier,
      quota,
      used,
      remaining,
      resetAt: nextUtcMidnight(at).toISOString(),
      secondsUntilReset: secondsUntilReset(at),
      ...(ip ? { ip } : {}),
    });
  };
}
