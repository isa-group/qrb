/**
 * Daily quota engine (task 4.1).
 *
 * Every identity (a keyless caller's IP, or a signed-in user) has a daily budget
 * of units, keyed by identity and UTC day in `quota_user_daily`. API-key requests carry the
 * key owner's `userId`, so keys and the browser session share one budget.
 *
 * Cost of a request (`requestCost`):
 * - `POST /api/select`, `POST /api/instance`, `POST /api/binds`: 1 unit (the API answers from the
 *   catalog it stores (queues refreshed every 2 minutes)), or `liveRefreshWeight` when the
 *   EFFECTIVE `force_refresh` is true (a live fetch from the providers). An
 *   omitted `force_refresh` is the API's default, false; a non-boolean one
 *   costs the weight; see `effectiveForceRefresh`.
 * - `GET /api/catalog`, `GET /api/catalog/:id`: free unless the query sets
 *   `force_refresh` to a true value (the Python default there is false), then
 *   `liveRefreshWeight`.
 *
 * Accounting (`enforceQuota`):
 * - Reserve BEFORE forwarding with the single conditional upsert
 *   `tryConsumeDailyUnits`: concurrent requests serialise on the counter row
 *   and the total never exceeds the quota. No read-then-write in JS.
 * - Over quota: 429 `{"detail": ...}` with `Retry-After` (seconds to 00:00
 *   UTC); nothing is forwarded or written.
 * - Upstream answers 5xx (including the gateway's own 502 when the upstream
 *   is unreachable) or a later handler throws: refund atomically
 *   (`refundDailyUnits`, clamped at zero) on the day the units were taken.
 * - Any other status, including a 4xx from the upstream, keeps the charge:
 *   the spec exempts only 5xx after forwarding and 4xx BEFORE forwarding.
 *   The latter is guaranteed by mounting this middleware after every
 *   validator (`readJsonBody`, `withApiKey`, ...) and right before
 *   `forward`.
 *
 * Response headers of every counted request: `X-Quota-Limit` (the tier's daily
 * units), `X-Quota-Remaining` (units left today after this request, refund
 * included) and `X-Quota-Reset` (Unix seconds of the next 00:00 UTC).
 * Every 429 has a `detail` naming the limit and a `Retry-After` in seconds.
 *
 * Keyless callers (no session, no API key) are identified by IP
 * (`ip:<client IP>`, see `../auth/anonymous.ts`), so the `anonymous` tier's
 * daily units are shared by everyone at one address.
 */
import type { Context, MiddlewareHandler, Next } from "hono";
import type { Database } from "../db";
import { addDailyUnits, refundDailyUnits, tryConsumeDailyUnits, utcDay } from "../db/counters";
import type { GatewayEnv } from "../forward";
import type { LimitsConfig, Tier } from "./config";
import { logWouldReject } from "./log";

/** What a counted request reserved. Available as `c.get("quota")` (for 4.5 headers / usage). */
export interface QuotaReservation {
  userId: string;
  tier: Tier;
  /** Daily quota of the tier. */
  quota: number;
  /** Units charged for this request. */
  cost: number;
  /** UTC day the units were taken from, `YYYY-MM-DD`. */
  day: string;
  /** Units used today, including this request. */
  used: number;
  /** Units left today after this request. */
  remaining: number;
  /** Next 00:00 UTC, when the quota resets. */
  resetAt: Date;
  /** True once the units were given back (5xx). */
  refunded: boolean;
}

export type QuotaCheck =
  | { ok: true; reservation: QuotaReservation }
  | { ok: false; tier: Tier; quota: number; cost: number; day: string; resetAt: Date };

/** Values Pydantic accepts as `True` for a bool query parameter (case-insensitive). */
const TRUE_QUERY = new Set(["1", "true", "t", "yes", "y", "on"]);

/** The Python API's default `force_refresh` on resolve routes: use the stored catalog. */
const RESOLVE_DEFAULT_FORCE_REFRESH = false;

/**
 * The `force_refresh` the Python API will act on for a resolve request: the
 * body's value if it is a JSON boolean, false (the API default) when it is
 * absent, and true for any other value (a string, a number): Pydantic may
 * coerce "true" or 1 to true, so treating them as a live fetch can only
 * overcharge, never undercharge. `live: false` (the frozen snapshot) never
 * fetches. Relies on `readJsonBody` having stashed `jsonBody`.
 */
export function effectiveForceRefresh(c: Context<GatewayEnv>): boolean {
  if (c.req.method === "GET") {
    // Any true-ish occurrence counts (Starlette uses the last one; charging on
    // any can only overcharge). Python default on catalog routes is false.
    return c.req.queries("force_refresh")?.some((v) => TRUE_QUERY.has(v.trim().toLowerCase())) ?? false;
  }
  const body = c.get("jsonBody");
  if (body && typeof body === "object" && !Array.isArray(body)) {
    // The snapshot never fetches provider data, whatever force_refresh says.
    if ((body as Record<string, unknown>).live === false) return false;
    const v = (body as Record<string, unknown>).force_refresh;
    if (typeof v === "boolean") return v;
    if (v !== undefined && v !== null) return true;
  }
  return RESOLVE_DEFAULT_FORCE_REFRESH;
}

/** Units this request costs: 0 for free catalog reads, 1 or the live-refresh weight otherwise. */
export function requestCost(c: Context<GatewayEnv>, config: LimitsConfig): number {
  const live = effectiveForceRefresh(c);
  if (c.req.method === "GET") return live ? config.liveRefreshWeight : 0;
  return live ? config.liveRefreshWeight : 1;
}

export function tierOf(isAnonymous: boolean | undefined): Tier {
  return isAnonymous === false ? "signed_in" : "anonymous";
}

/** Next 00:00 UTC after `now`. */
export function nextUtcMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

/** Whole seconds until the next 00:00 UTC, at least 1 (a `Retry-After` value). */
export function secondsUntilReset(now: Date): number {
  return Math.max(1, Math.ceil((nextUtcMidnight(now).getTime() - now.getTime()) / 1000));
}

/**
 * Reserve `cost` units of `userId`'s quota for today. One conditional upsert;
 * returns the reservation (used / remaining / reset time) or the rejection.
 */
export async function consumeQuota(
  db: Database,
  config: LimitsConfig,
  args: { userId: string; tier: Tier; cost: number; now: Date },
): Promise<QuotaCheck> {
  const { userId, tier, cost, now } = args;
  const quota = config.dailyUnits[tier];
  const day = utcDay(now);
  const resetAt = nextUtcMidnight(now);
  let used = await tryConsumeDailyUnits(db, { table: "quota_user_daily", key: userId, day, units: cost, quota });
  if (used === null && config.mode === "log") {
    // Log-only: count the units anyway and let the request through.
    used = await addDailyUnits(db, { table: "quota_user_daily", key: userId, day, units: cost });
    logWouldReject({ limit: "user_daily", key: userId, status: 429, tier, quota, cost, used });
  }
  if (used === null) return { ok: false, tier, quota, cost, day, resetAt };
  return {
    ok: true,
    reservation: { userId, tier, quota, cost, day, used, remaining: Math.max(0, quota - used), resetAt, refunded: false },
  };
}

/** Give a reservation's units back (idempotent per reservation). */
export async function refundQuota(db: Database, r: QuotaReservation): Promise<void> {
  if (r.refunded) return;
  r.refunded = true;
  // The counters' new totals (other requests may have moved them meanwhile) feed the quota headers.
  const used = await refundDailyUnits(db, { table: "quota_user_daily", key: r.userId, day: r.day, units: r.cost });
  r.used = used ?? Math.max(0, r.used - r.cost);
  r.remaining = Math.max(0, r.quota - r.used);
}

export const QUOTA_LIMIT_HEADER = "X-Quota-Limit";
export const QUOTA_REMAINING_HEADER = "X-Quota-Remaining";
export const QUOTA_RESET_HEADER = "X-Quota-Reset";
/** For `Access-Control-Expose-Headers` (`../cors.ts`). */
export const QUOTA_HEADERS = [QUOTA_LIMIT_HEADER, QUOTA_REMAINING_HEADER, QUOTA_RESET_HEADER] as const;

export interface QuotaOptions {
  /** Gateway database (shared with Better Auth). */
  getDb: () => Promise<Database>;
  config: LimitsConfig;
  /** Clock, injectable for tests. */
  now?: () => Date;
}

const QUOTA_EXCEEDED: Record<Tier, (quota: number, cost: number) => string> = {
  anonymous: (quota, cost) =>
    `Daily quota exceeded: callers without an API key share ${quota} units per day per IP address ` +
    `and this request costs ${cost}. Sign in and send an API key in x-api-key for your own quota. ` +
    `The quota resets at 00:00 UTC.`,
  signed_in: (quota, cost) =>
    `Daily quota exceeded: signed-in users get ${quota} units per day and this request costs ${cost}. ` +
    `The quota resets at 00:00 UTC.`,
};

/**
 * Middleware charging the caller's daily quota. Mount right before `forward`,
 * after identity resolution and every validator.
 */
export function enforceQuota(opts: QuotaOptions): MiddlewareHandler<GatewayEnv> {
  const now = opts.now ?? (() => new Date());
  return async (c: Context<GatewayEnv>, next: Next) => {
    const userId = c.get("userId");
    const cost = requestCost(c, opts.config);
    if (cost === 0 || !userId) return next();

    const db = await opts.getDb();
    const at = now();
    const check = await consumeQuota(db, opts.config, { userId, tier: tierOf(c.get("isAnonymous")), cost, now: at });
    if (!check.ok) {
      c.header("Retry-After", String(secondsUntilReset(at)));
      return c.json({ detail: QUOTA_EXCEEDED[check.tier](check.quota, check.cost) }, 429);
    }
    const reservation = check.reservation;
    c.set("quota", reservation);

    const refund = async () => {
      try {
        await refundQuota(db, reservation);
      } catch (e) {
        // Keep the upstream response; the caller is overcharged at worst.
        console.error("quota refund failed", e);
      }
    };
    try {
      await next();
    } catch (e) {
      await refund();
      throw e;
    }
    if (c.res.status >= 500) await refund();
    // Reported after a possible refund, so a failed call shows the restored value.
    c.header(QUOTA_LIMIT_HEADER, String(reservation.quota));
    c.header(QUOTA_REMAINING_HEADER, String(reservation.remaining));
    c.header(QUOTA_RESET_HEADER, String(Math.floor(reservation.resetAt.getTime() / 1000)));
  };
}

