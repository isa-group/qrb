/**
 * Daily quota engine (task 4.1).
 *
 * Every identity (anonymous or signed in) has a daily budget of units, keyed
 * by user id and UTC day in `quota_user_daily`. API-key requests carry the
 * key owner's `userId`, so keys and the browser session share one budget.
 *
 * Cost of a request (`requestCost`):
 * - `POST /api/select`, `POST /api/instance`: 1 unit, or `liveRefreshWeight`
 *   when the EFFECTIVE `force_refresh` is true. The Python API defaults
 *   `force_refresh` to true on these routes, so an omitted (or non-boolean)
 *   value costs the weight; see `effectiveForceRefresh`.
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
 *   validator (`rejectSnapshotPath`, `withApiKey`, ...) and right before
 *   `forward`.
 *
 * Response headers of every counted request: `X-Quota-Limit` (the tier's daily
 * units), `X-Quota-Remaining` (units left today after this request, refund
 * included; for anonymous callers the smaller of the user's and the per-IP
 * cap's remainder) and `X-Quota-Reset` (Unix seconds of the next 00:00 UTC).
 * Every 429 has a `detail` naming the limit and a `Retry-After` in seconds.
 *
 * Requests without an identity (open catalog routes called without session
 * or key) are not charged here; task 4.2 decides whether they may live
 * refresh at all.
 *
 * Per-IP anonymous cap (task 4.3): an anonymous request is ALSO charged to
 * `quota_ip_daily` under its client IP (`c.get("clientIp")`, see
 * `../client-ip.ts`), so all anonymous identities at one IP share
 * `anonymousIpDailyUnits` per day and a fresh identity (cleared cookies)
 * does not reset it. Both counters are reserved before forwarding (user
 * first; if the IP cap then rejects, the user units are given back) and both
 * are refunded on 5xx. Signed-in and API-key requests never touch the IP
 * counter. `anonymousIpGate` repeats the IP check as a plain read BEFORE an
 * anonymous identity is created, so a capped IP mints no new identities; the
 * atomic reservation here stays the authority (the gate can race, this
 * cannot).
 */
import type { Context, MiddlewareHandler, Next } from "hono";
import type { Database } from "../db";
import { UNKNOWN_CLIENT } from "../client-ip";
import { addDailyUnits, dailyUnitsUsed, refundDailyUnits, tryConsumeDailyUnits, utcDay } from "../db/counters";
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
  /** Anonymous requests only: the per-IP cap reservation (same `cost` and `day`). */
  ip?: { key: string; quota: number; used: number; remaining: number };
}

export type QuotaCheck =
  | { ok: true; reservation: QuotaReservation }
  | { ok: false; tier: Tier; quota: number; cost: number; day: string; resetAt: Date };

/** Values Pydantic accepts as `True` for a bool query parameter (case-insensitive). */
const TRUE_QUERY = new Set(["1", "true", "t", "yes", "y", "on"]);

/** Python defaults of `force_refresh` per route, from the http-api spec. */
const RESOLVE_DEFAULT_FORCE_REFRESH = true;

/**
 * The `force_refresh` the Python API will act on for a resolve request: the
 * body's value if it is a JSON boolean, else the route default (true). Any
 * non-boolean (string, number, missing body) falls back to the default, which
 * can only overcharge, never undercharge, whatever Pydantic coerces it to.
 * Relies on `rejectSnapshotPath` having stashed `jsonBody`.
 */
export function effectiveForceRefresh(c: Context<GatewayEnv>): boolean {
  if (c.req.method === "GET") {
    // Any true-ish occurrence counts (Starlette uses the last one; charging on
    // any can only overcharge). Python default on catalog routes is false.
    return c.req.queries("force_refresh")?.some((v) => TRUE_QUERY.has(v.trim().toLowerCase())) ?? false;
  }
  const body = c.get("jsonBody");
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const v = (body as Record<string, unknown>).force_refresh;
    if (typeof v === "boolean") return v;
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

/** Give a reservation's units back, user and per-IP (idempotent per reservation). */
export async function refundQuota(db: Database, r: QuotaReservation): Promise<void> {
  if (r.refunded) return;
  r.refunded = true;
  // The counters' new totals (other requests may have moved them meanwhile) feed the quota headers.
  const used = await refundDailyUnits(db, { table: "quota_user_daily", key: r.userId, day: r.day, units: r.cost });
  r.used = used ?? Math.max(0, r.used - r.cost);
  r.remaining = Math.max(0, r.quota - r.used);
  if (r.ip) {
    const ipUsed = await refundDailyUnits(db, { table: "quota_ip_daily", key: r.ip.key, day: r.day, units: r.cost });
    r.ip.used = ipUsed ?? Math.max(0, r.ip.used - r.cost);
    r.ip.remaining = Math.max(0, r.ip.quota - r.ip.used);
  }
}

export const QUOTA_LIMIT_HEADER = "X-Quota-Limit";
export const QUOTA_REMAINING_HEADER = "X-Quota-Remaining";
export const QUOTA_RESET_HEADER = "X-Quota-Reset";
/** For `Access-Control-Expose-Headers` (`../cors.ts`). */
export const QUOTA_HEADERS = [QUOTA_LIMIT_HEADER, QUOTA_REMAINING_HEADER, QUOTA_RESET_HEADER] as const;

/** Units the caller can still spend today: the user's, and for anonymous callers at most the IP cap's. */
export function effectiveRemaining(r: Pick<QuotaReservation, "remaining" | "ip">): number {
  return r.ip ? Math.min(r.remaining, r.ip.remaining) : r.remaining;
}

export type IpCapCheck = { ok: true; used: number } | { ok: false };

/** Reserve `cost` units of the per-IP anonymous cap for the UTC day of `now`. */
export async function consumeIpCap(db: Database, config: LimitsConfig, args: { ip: string; cost: number; now: Date }): Promise<IpCapCheck> {
  const day = utcDay(args.now);
  let used = await tryConsumeDailyUnits(db, { table: "quota_ip_daily", key: args.ip, day, units: args.cost, quota: config.anonymousIpDailyUnits });
  if (used === null && config.mode === "log") {
    used = await addDailyUnits(db, { table: "quota_ip_daily", key: args.ip, day, units: args.cost });
    logWouldReject({ limit: "ip_daily", key: args.ip, status: 429, quota: config.anonymousIpDailyUnits, cost: args.cost, used });
  }
  return used === null ? { ok: false } : { ok: true, used };
}

function ipCapExceeded(c: Context<GatewayEnv>, config: LimitsConfig, cost: number, at: Date) {
  c.header("Retry-After", String(secondsUntilReset(at)));
  return c.json(
    {
      detail:
        `Per-IP daily cap exceeded: anonymous users at one IP address share ${config.anonymousIpDailyUnits} units ` +
        `per day and this request costs ${cost}. Sign in for your own quota; the cap resets at 00:00 UTC.`,
    },
    429,
  );
}

/** Whether the request will be charged as anonymous (no key, and no signed-in session). */
const chargedAsAnonymous = (c: Context<GatewayEnv>) => !c.get("apiKeyId") && c.get("isAnonymous") !== false;

export interface QuotaOptions {
  /** Gateway database (shared with Better Auth). */
  getDb: () => Promise<Database>;
  config: LimitsConfig;
  /** Clock, injectable for tests. */
  now?: () => Date;
}

const TIER_LABEL: Record<Tier, string> = { anonymous: "anonymous", signed_in: "signed-in" };

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
      return c.json(
        {
          detail:
            `Daily quota exceeded: ${TIER_LABEL[check.tier]} users get ${check.quota} units per day ` +
            `and this request costs ${check.cost}. The quota resets at 00:00 UTC.`,
        },
        429,
      );
    }
    const reservation = check.reservation;
    if (reservation.tier === "anonymous" && chargedAsAnonymous(c)) {
      const ip = c.get("clientIp") ?? UNKNOWN_CLIENT;
      let ipCheck: IpCapCheck;
      try {
        ipCheck = await consumeIpCap(db, opts.config, { ip, cost, now: at });
      } catch (e) {
        await refundQuota(db, reservation).catch(() => undefined);
        throw e;
      }
      if (!ipCheck.ok) {
        await refundQuota(db, reservation);
        return ipCapExceeded(c, opts.config, cost, at);
      }
      const cap = opts.config.anonymousIpDailyUnits;
      reservation.ip = { key: ip, quota: cap, used: ipCheck.used, remaining: Math.max(0, cap - ipCheck.used) };
    }
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
    c.header(QUOTA_REMAINING_HEADER, String(effectiveRemaining(reservation)));
    c.header(QUOTA_RESET_HEADER, String(Math.floor(reservation.resetAt.getTime() / 1000)));
  };
}

/**
 * Pre-check of the per-IP anonymous cap, mounted BEFORE `ensureIdentity` on
 * resolve routes: an anonymous (or not yet identified) caller whose IP has
 * already used the cap gets 429 and no identity is created. A plain read; the
 * atomic reservation in `enforceQuota` remains the authority.
 */
export function anonymousIpGate(opts: QuotaOptions): MiddlewareHandler<GatewayEnv> {
  const now = opts.now ?? (() => new Date());
  return async (c: Context<GatewayEnv>, next: Next) => {
    if (!chargedAsAnonymous(c)) return next();
    const cost = requestCost(c, opts.config);
    if (cost === 0) return next();
    const at = now();
    const used = await dailyUnitsUsed(await opts.getDb(), "quota_ip_daily", c.get("clientIp") ?? UNKNOWN_CLIENT, utcDay(at));
    if (used + cost > opts.config.anonymousIpDailyUnits) {
      if (opts.config.mode !== "log") return ipCapExceeded(c, opts.config, cost, at);
      logWouldReject({ limit: "ip_daily_gate", key: c.get("clientIp") ?? UNKNOWN_CLIENT, status: 429, quota: opts.config.anonymousIpDailyUnits, cost, used });
    }
    return next();
  };
}
