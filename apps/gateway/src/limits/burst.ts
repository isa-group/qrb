/**
 * Burst rate limits (task 4.3): sliding windows in Postgres (`burst_bucket`),
 * so they hold across restarts and gateway instances.
 *
 * Algorithm: fixed windows of `W` seconds; the estimate for "now" is
 *   count(current window) + count(previous window) * (1 - elapsed / W)
 * and a request is allowed if the estimate plus itself stays within the
 * limit (`tryConsumeBurst`, one atomic statement).
 *
 * What counts: every request that REACHES the limiter and is allowed, whatever
 * happens afterwards. Unlike the daily quota there is no refund on 5xx: a
 * burst limit protects the gateway and the upstream from request volume, and
 * failing requests are still volume (a client retrying in a tight loop on 5xx
 * must still be slowed down). Requests the limiter itself rejects are NOT
 * counted, so a client that keeps hammering regains access as the window
 * slides instead of being locked out indefinitely.
 *
 * Limits:
 * - `burstLimit` (resolve routes, and catalog requests that cost units):
 *   API-key requests count only against their key (`burst:api_key`), so a
 *   runaway script exhausts its own key and not its owner's browser session
 *   or other keys; session requests count against the identity
 *   (`burst:anonymous` / `burst:signed_in`, keyed by user id). Free requests
 *   (cost 0, e.g. a cached catalog read) are not counted here.
 * - `openRouteLimit` (health, catalog, engines, presets): per client IP for
 *   every caller, identified or not.
 *
 * Rejections: 429 `{"detail": ...}` naming the limit, with `Retry-After` =
 * seconds until the sliding estimate admits one more request.
 */
import type { Context, MiddlewareHandler, Next } from "hono";
import type { Database } from "../db";
import { addBurst, burstCounts, tryConsumeBurst } from "../db/counters";
import { UNKNOWN_CLIENT } from "../client-ip";
import type { GatewayEnv } from "../forward";
import type { LimitsConfig } from "./config";
import { logWouldReject } from "./log";
import { requestCost, tierOf } from "./quota";

export interface SlidingWindow {
  windowStart: Date;
  previousStart: Date;
  /** Milliseconds since `windowStart`. */
  elapsedMs: number;
  /** `1 - elapsed / window`. */
  previousWeight: number;
}

export function slidingWindow(now: Date, windowSeconds: number): SlidingWindow {
  const w = windowSeconds * 1000;
  const t = now.getTime();
  const start = Math.floor(t / w) * w;
  const elapsedMs = t - start;
  return { windowStart: new Date(start), previousStart: new Date(start - w), elapsedMs, previousWeight: 1 - elapsedMs / w };
}

/**
 * Milliseconds from `elapsedMs` (into the current window) until
 * `current + 1 + previous * (1 - e / W) <= limit` holds, possibly in the next
 * window (where `current` becomes the previous count). 0 if it holds now.
 */
export function burstRetryAfterMs(current: number, previous: number, limit: number, elapsedMs: number, windowMs: number): number {
  if (current + 1 <= limit) {
    // Wait for the previous window's weight to drop enough.
    const e = previous > 0 ? windowMs * (1 - (limit - current - 1) / previous) : 0;
    if (e < windowMs) return Math.max(0, e - elapsedMs);
  }
  // The current window is full: wait for the next one, then for its weight to drop.
  const next = current > 0 ? Math.max(0, windowMs * (1 - (limit - 1) / current)) : 0;
  return windowMs - elapsedMs + next;
}

export interface BurstCheck {
  ok: boolean;
  /** Seconds until another request is allowed (at least 1); set when rejected. */
  retryAfter?: number;
}

/** One sliding-window step for (scope, key). */
export async function consumeBurst(
  db: Database,
  args: { scope: string; key: string; limit: number; windowSeconds: number; now: Date; mode?: "enforce" | "log" },
): Promise<BurstCheck> {
  const win = slidingWindow(args.now, args.windowSeconds);
  const counted = await tryConsumeBurst(db, { scope: args.scope, key: args.key, limit: args.limit, ...win });
  if (counted !== null) return { ok: true };
  const { current, previous } = await burstCounts(db, { scope: args.scope, key: args.key, ...win });
  const ms = burstRetryAfterMs(current, previous, args.limit, win.elapsedMs, args.windowSeconds * 1000);
  // Log-only: a rejected request is counted anyway (the caller logs and lets it through).
  if (args.mode === "log") await addBurst(db, { scope: args.scope, key: args.key, windowStart: win.windowStart });
  // The epsilon absorbs float noise (60000 * (1 - 0.7) = 18000.000000000004) that would add a whole second.
  return { ok: false, retryAfter: Math.max(1, Math.ceil(ms / 1000 - 1e-6)) };
}

export interface BurstOptions {
  getDb: () => Promise<Database>;
  config: LimitsConfig;
  now?: () => Date;
}

const per = (n: number, windowSeconds: number) => `${n} request${n === 1 ? "" : "s"} per ${windowSeconds === 60 ? "minute" : `${windowSeconds} seconds`}`;

function rejected(c: Context<GatewayEnv>, retryAfter: number, detail: string) {
  c.header("Retry-After", String(retryAfter));
  return c.json({ detail: `${detail} Retry in ${retryAfter} s.` }, 429);
}

/**
 * Per-identity / per-key burst limit. Mount after identity resolution and
 * before `quota` (a burst rejection charges no units).
 */
export function burstLimit(opts: BurstOptions): MiddlewareHandler<GatewayEnv> {
  const now = opts.now ?? (() => new Date());
  const { burst } = opts.config;
  return async (c: Context<GatewayEnv>, next: Next) => {
    const userId = c.get("userId");
    if (!userId || requestCost(c, opts.config) === 0) return next();
    const keyId = c.get("apiKeyId");
    const tier = keyId ? "api_key" : tierOf(c.get("isAnonymous"));
    const limit = burst[tier];
    const check = await consumeBurst(await opts.getDb(), {
      scope: `burst:${tier}:${burst.windowSeconds}s`,
      key: keyId ?? userId,
      limit,
      windowSeconds: burst.windowSeconds,
      now: now(),
      mode: opts.config.mode,
    });
    if (check.ok) return next();
    if (opts.config.mode === "log") {
      logWouldReject({ limit: `burst:${tier}`, key: keyId ?? userId, status: 429, max: limit, windowSeconds: burst.windowSeconds, retryAfter: check.retryAfter });
      return next();
    }
    const who = { api_key: "this API key", anonymous: "anonymous users", signed_in: "signed-in users" }[tier];
    return rejected(c, check.retryAfter!, `Burst limit exceeded: ${who} may make ${per(limit, burst.windowSeconds)}.`);
  };
}

/** Per-IP rate limit for open routes. Mount first on each open route. */
export function openRouteLimit(opts: BurstOptions): MiddlewareHandler<GatewayEnv> {
  const now = opts.now ?? (() => new Date());
  const { openRoutePerIp: open } = opts.config;
  return async (c: Context<GatewayEnv>, next: Next) => {
    const check = await consumeBurst(await opts.getDb(), {
      scope: `open:ip:${open.windowSeconds}s`,
      key: c.get("clientIp") ?? UNKNOWN_CLIENT,
      limit: open.limit,
      windowSeconds: open.windowSeconds,
      now: now(),
      mode: opts.config.mode,
    });
    if (check.ok) return next();
    if (opts.config.mode === "log") {
      logWouldReject({ limit: "open_route_ip", key: c.get("clientIp") ?? UNKNOWN_CLIENT, status: 429, max: open.limit, windowSeconds: open.windowSeconds, retryAfter: check.retryAfter });
      return next();
    }
    return rejected(c, check.retryAfter!, `Rate limit exceeded: open routes allow ${per(open.limit, open.windowSeconds)} per IP address.`);
  };
}
