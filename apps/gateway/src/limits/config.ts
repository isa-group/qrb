/**
 * Limits configuration: the single place the gateway's quota and rate-limit
 * numbers come from. Defaults are the design's "Proposed default limits".
 *
 * Task 4.1 defines the daily user quota and the live-refresh weight; task
 * 4.3 the per-IP anonymous cap and the burst limits. Task 4.6 adds
 * `limitsConfigFromEnv` (environment variables, see `.env.example`) and the
 * log-only `mode`: quotas and rate limits that would reject only log a line
 * (`./log.ts`) and let the request through, counters still increase.
 */

/** Quota tier of an identity. API keys resolve to their owner, so they use `signed_in`. */
export type Tier = "anonymous" | "signed_in";

/** `enforce` rejects with 429; `log` records what would have been rejected and lets the request through. */
export type LimitsMode = "enforce" | "log";

export interface LimitsConfig {
  /** Quotas and rate limits only; policy and auth rejections (401/403/422) always apply. */
  mode: LimitsMode;
  /** Daily resolve units per user, by tier; reset at 00:00 UTC. */
  dailyUnits: Record<Tier, number>;
  /** Units charged instead of one when the effective `force_refresh` is true. */
  liveRefreshWeight: number;
  /**
   * Daily units shared by ALL anonymous identities at one client IP (IPv6:
   * one /64), same units as `dailyUnits`; reset at 00:00 UTC. Signed-in and
   * API-key requests do not count against it.
   */
  anonymousIpDailyUnits: number;
  /**
   * Sliding-window burst limits on counted requests: per identity by tier
   * (browser session, anonymous or signed in) and per API key (each key on
   * its own, independent of the owner's session and other keys).
   */
  burst: { windowSeconds: number } & Record<Tier | "api_key", number>;
  /** Sliding-window rate limit per client IP on open routes (health, catalog, engines, presets). */
  openRoutePerIp: { windowSeconds: number; limit: number };
}

export const DEFAULT_LIMITS: Readonly<LimitsConfig> = Object.freeze({
  mode: "enforce" as LimitsMode,
  dailyUnits: Object.freeze({ anonymous: 10, signed_in: 200 }),
  liveRefreshWeight: 5,
  anonymousIpDailyUnits: 30,
  burst: Object.freeze({ windowSeconds: 60, anonymous: 3, signed_in: 20, api_key: 20 }),
  // Not in the design table: a page view of the web app makes about three
  // open-route calls, so 60 per minute leaves room for a busy shared IP.
  openRoutePerIp: Object.freeze({ windowSeconds: 60, limit: 60 }),
});

export type LimitsOverrides = {
  mode?: LimitsMode;
  dailyUnits?: Partial<Record<Tier, number>>;
  liveRefreshWeight?: number;
  anonymousIpDailyUnits?: number;
  burst?: Partial<LimitsConfig["burst"]>;
  openRoutePerIp?: Partial<LimitsConfig["openRoutePerIp"]>;
};

function nonNegativeInt(name: string, v: number): number {
  if (!Number.isInteger(v) || v < 0) throw new RangeError(`${name} must be a non-negative integer, got ${v}`);
  return v;
}

function positiveInt(name: string, v: number): number {
  if (!Number.isInteger(v) || v < 1) throw new RangeError(`${name} must be a positive integer, got ${v}`);
  return v;
}

/** Defaults merged with `overrides`, validated (throws `RangeError` on bad values). */
export function limitsConfig(overrides: LimitsOverrides = {}): LimitsConfig {
  const daily = { ...DEFAULT_LIMITS.dailyUnits, ...overrides.dailyUnits };
  const weight = overrides.liveRefreshWeight ?? DEFAULT_LIMITS.liveRefreshWeight;
  const burst = { ...DEFAULT_LIMITS.burst, ...overrides.burst };
  const open = { ...DEFAULT_LIMITS.openRoutePerIp, ...overrides.openRoutePerIp };
  if (!Number.isInteger(weight) || weight < 1) throw new RangeError(`liveRefreshWeight must be a positive integer, got ${weight}`);
  const mode = overrides.mode ?? DEFAULT_LIMITS.mode;
  if (mode !== "enforce" && mode !== "log") throw new RangeError(`mode must be "enforce" or "log", got ${mode}`);
  return {
    mode,
    dailyUnits: {
      anonymous: nonNegativeInt("dailyUnits.anonymous", daily.anonymous),
      signed_in: nonNegativeInt("dailyUnits.signed_in", daily.signed_in),
    },
    liveRefreshWeight: weight,
    anonymousIpDailyUnits: nonNegativeInt("anonymousIpDailyUnits", overrides.anonymousIpDailyUnits ?? DEFAULT_LIMITS.anonymousIpDailyUnits),
    burst: {
      windowSeconds: positiveInt("burst.windowSeconds", burst.windowSeconds),
      anonymous: positiveInt("burst.anonymous", burst.anonymous),
      signed_in: positiveInt("burst.signed_in", burst.signed_in),
      api_key: positiveInt("burst.api_key", burst.api_key),
    },
    openRoutePerIp: {
      windowSeconds: positiveInt("openRoutePerIp.windowSeconds", open.windowSeconds),
      limit: positiveInt("openRoutePerIp.limit", open.limit),
    },
  };
}

type Env = Record<string, string | undefined>;

/** Integer environment variable; unset or empty means "use the default" (undefined). */
function envInt(env: Env, name: string, min: 0 | 1): number | undefined {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  const v = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(v) || v < min) {
    throw new RangeError(`${name} must be ${min === 0 ? "a non-negative" : "a positive"} integer, got "${raw}"`);
  }
  return v;
}

/**
 * Limits from the environment (all optional, defaults are `DEFAULT_LIMITS`):
 *
 * - `QRB_LIMITS_MODE`: `enforce` (default) or `log` (log-only rollout)
 * - `QRB_LIMIT_ANON_DAILY`, `QRB_LIMIT_SIGNED_IN_DAILY`: daily units per user
 * - `QRB_LIMIT_LIVE_REFRESH_WEIGHT`: units a live refresh costs
 * - `QRB_LIMIT_ANON_IP_DAILY`: daily units shared by anonymous users at one IP
 * - `QRB_LIMIT_BURST_WINDOW_SECONDS`, `QRB_LIMIT_BURST_ANON`,
 *   `QRB_LIMIT_BURST_SIGNED_IN`, `QRB_LIMIT_BURST_API_KEY`: burst limits
 * - `QRB_LIMIT_OPEN_WINDOW_SECONDS`, `QRB_LIMIT_OPEN_PER_IP`: open-route limit per IP
 *
 * An invalid value throws an error naming the variable, so a bad deployment
 * fails at startup.
 */
export function limitsConfigFromEnv(env: Env = process.env): LimitsConfig {
  const rawMode = env.QRB_LIMITS_MODE?.trim().toLowerCase();
  if (rawMode && rawMode !== "enforce" && rawMode !== "log") {
    throw new RangeError(`QRB_LIMITS_MODE must be "enforce" or "log", got "${env.QRB_LIMITS_MODE}"`);
  }
  const drop = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
  return limitsConfig({
    mode: (rawMode || undefined) as LimitsMode | undefined,
    dailyUnits: drop({ anonymous: envInt(env, "QRB_LIMIT_ANON_DAILY", 0), signed_in: envInt(env, "QRB_LIMIT_SIGNED_IN_DAILY", 0) }),
    liveRefreshWeight: envInt(env, "QRB_LIMIT_LIVE_REFRESH_WEIGHT", 1),
    anonymousIpDailyUnits: envInt(env, "QRB_LIMIT_ANON_IP_DAILY", 0),
    burst: drop({
      windowSeconds: envInt(env, "QRB_LIMIT_BURST_WINDOW_SECONDS", 1),
      anonymous: envInt(env, "QRB_LIMIT_BURST_ANON", 1),
      signed_in: envInt(env, "QRB_LIMIT_BURST_SIGNED_IN", 1),
      api_key: envInt(env, "QRB_LIMIT_BURST_API_KEY", 1),
    }),
    openRoutePerIp: drop({
      windowSeconds: envInt(env, "QRB_LIMIT_OPEN_WINDOW_SECONDS", 1),
      limit: envInt(env, "QRB_LIMIT_OPEN_PER_IP", 1),
    }),
  });
}
