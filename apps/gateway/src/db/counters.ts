import { sql } from "kysely";
import type { Database } from "./index";

const DAILY_TABLES = {
  quota_user_daily: "user_id",
  quota_ip_daily: "ip",
} as const;

export type DailyCounterTable = keyof typeof DAILY_TABLES;

export interface ConsumeDailyUnits {
  table: DailyCounterTable;
  /** user id for `quota_user_daily`, client IP for `quota_ip_daily`. */
  key: string;
  /** UTC day, `YYYY-MM-DD`. */
  day: string;
  units: number;
  quota: number;
}

/**
 * Consume `units` only if `units_used + units <= quota`, in ONE statement.
 *
 * The insert path covers the first request of the day (and is filtered by
 * `WHERE units <= quota`); the `ON CONFLICT DO UPDATE ... WHERE` path covers
 * the rest. Postgres locks the conflicting row and evaluates the WHERE
 * against its latest committed version, so concurrent callers on any number
 * of connections or gateway instances serialise on the row and the total
 * never exceeds the quota. Returns the new total, or `null` if rejected
 * (nothing is written in that case).
 *
 * Task 4.1 owns how this is used (reserve before forwarding, give the units
 * back on a 5xx with `units_used = units_used - n`).
 */
export async function tryConsumeDailyUnits(
  db: Database,
  { table, key, day, units, quota }: ConsumeDailyUnits,
): Promise<number | null> {
  if (!Number.isInteger(units) || units < 1) throw new RangeError(`units must be a positive integer, got ${units}`);
  if (!Number.isInteger(quota) || quota < 0) throw new RangeError(`quota must be a non-negative integer, got ${quota}`);
  const keyColumn = DAILY_TABLES[table];
  // Casts matter: untyped parameters compared to each other default to text.
  const { rows } = await sql<{ units_used: number }>`
    INSERT INTO ${sql.table(table)} AS c (${sql.ref(keyColumn)}, day, units_used)
    SELECT ${key}::text, ${day}::date, ${units}::integer
    WHERE ${units}::integer <= ${quota}::integer
    ON CONFLICT (${sql.ref(keyColumn)}, day) DO UPDATE
      SET units_used = c.units_used + EXCLUDED.units_used, updated_at = now()
      WHERE c.units_used + EXCLUDED.units_used <= ${quota}::integer
    RETURNING c.units_used
  `.execute(db);
  return rows[0]?.units_used ?? null;
}

/**
 * Unconditional counterpart of `tryConsumeDailyUnits` for log-only mode: add
 * `units` whether or not the quota is exceeded, in ONE statement, and return
 * the new total. Counters keep growing so the log-only phase shows real usage.
 */
export async function addDailyUnits(db: Database, { table, key, day, units }: Omit<ConsumeDailyUnits, "quota">): Promise<number> {
  if (!Number.isInteger(units) || units < 1) throw new RangeError(`units must be a positive integer, got ${units}`);
  const keyColumn = DAILY_TABLES[table];
  const { rows } = await sql<{ units_used: number }>`
    INSERT INTO ${sql.table(table)} AS c (${sql.ref(keyColumn)}, day, units_used)
    VALUES (${key}::text, ${day}::date, ${units}::integer)
    ON CONFLICT (${sql.ref(keyColumn)}, day) DO UPDATE
      SET units_used = c.units_used + EXCLUDED.units_used, updated_at = now()
    RETURNING c.units_used
  `.execute(db);
  return rows[0]!.units_used;
}

export interface RefundDailyUnits {
  table: DailyCounterTable;
  key: string;
  /** The day the units were consumed on (not necessarily today). */
  day: string;
  units: number;
}

/**
 * Give back `units` previously taken by `tryConsumeDailyUnits` (the forwarded
 * call failed with 5xx). One statement, so it is atomic against concurrent
 * consumes on the same row, and clamped at zero: a refund racing a
 * `moveDailyUnits` that emptied the row (anonymous sign-in) never makes the
 * counter negative. Returns the new total, or `null` if there was no row.
 */
export async function refundDailyUnits(db: Database, { table, key, day, units }: RefundDailyUnits): Promise<number | null> {
  if (!Number.isInteger(units) || units < 1) throw new RangeError(`units must be a positive integer, got ${units}`);
  const keyColumn = DAILY_TABLES[table];
  const { rows } = await sql<{ units_used: number }>`
    UPDATE ${sql.table(table)}
      SET units_used = greatest(units_used - ${units}::integer, 0), updated_at = now()
      WHERE ${sql.ref(keyColumn)} = ${key}::text AND day = ${day}::date
    RETURNING units_used
  `.execute(db);
  return rows[0]?.units_used ?? null;
}

/** UTC day of `now` as `YYYY-MM-DD`, the `day` key of the daily counters. */
export function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Carry a user's daily units over to another user (anonymous identity linked
 * to an account on sign-in). Removes ALL of `fromUserId`'s rows and adds the
 * units of `day` to `toUserId`'s row for that day (created if missing, summed
 * otherwise). Older days are dropped: only today counts toward a quota.
 *
 * One statement, so it is atomic on its own: the delete and the upsert commit
 * or fail together, and a concurrent consume on the target row serialises on
 * the row lock (the sum is never lost). The total may exceed the target's
 * quota; the quota engine then rejects further requests that day.
 *
 * Returns the units moved (0 if there was no row for `day`).
 */
export async function moveDailyUnits(db: Database, fromUserId: string, toUserId: string, day: string): Promise<number> {
  if (fromUserId === toUserId) return 0;
  // Data-modifying CTEs always run to completion, referenced or not.
  const { rows } = await sql<{ moved: number }>`
    WITH moved AS (
      DELETE FROM quota_user_daily
      WHERE user_id = ${fromUserId}::text
      RETURNING day, units_used
    ), today AS (
      SELECT units_used FROM moved WHERE day = ${day}::date AND units_used > 0
    ), added AS (
      INSERT INTO quota_user_daily AS c (user_id, day, units_used)
      SELECT ${toUserId}::text, ${day}::date, units_used FROM today
      ON CONFLICT (user_id, day) DO UPDATE
        SET units_used = c.units_used + EXCLUDED.units_used, updated_at = now()
      RETURNING 1
    )
    SELECT coalesce(sum(units_used), 0)::int AS moved FROM today
  `.execute(db);
  return rows[0]?.moved ?? 0;
}

/** Units used on `day` for `key` (0 without a row). A plain read, for pre-checks only. */
export async function dailyUnitsUsed(db: Database, table: DailyCounterTable, key: string, day: string): Promise<number> {
  const keyColumn = DAILY_TABLES[table];
  const { rows } = await sql<{ units_used: number }>`
    SELECT units_used FROM ${sql.table(table)} WHERE ${sql.ref(keyColumn)} = ${key}::text AND day = ${day}::date
  `.execute(db);
  return rows[0]?.units_used ?? 0;
}

export interface ConsumeBurst {
  /** Names the limit and implies its window length, e.g. `burst:api_key:60s`. */
  scope: string;
  /** User id, API key id or client IP. */
  key: string;
  /** Start of the current fixed window. */
  windowStart: Date;
  /** Start of the previous fixed window. */
  previousStart: Date;
  /** Weight of the previous window's count, `1 - elapsed / window`, in [0, 1]. */
  previousWeight: number;
  limit: number;
}

/**
 * Sliding-window step on `burst_bucket`, in ONE statement: count this request
 * in the current window only if
 *   current + 1 + previous * previousWeight <= limit.
 * The previous window is closed (no longer incremented), so reading it in the
 * same statement is enough; the current row is serialised by
 * `INSERT ... ON CONFLICT DO UPDATE ... WHERE`, exactly like the daily
 * counters, so concurrent requests on any number of connections never
 * overshoot. A rejected request is not counted. Returns the current window's
 * new count, or `null` if rejected.
 */
export async function tryConsumeBurst(db: Database, b: ConsumeBurst): Promise<number | null> {
  if (!Number.isInteger(b.limit) || b.limit < 1) throw new RangeError(`limit must be a positive integer, got ${b.limit}`);
  const weight = Math.min(1, Math.max(0, b.previousWeight));
  const { rows } = await sql<{ count: number }>`
    WITH prev AS (
      SELECT coalesce((
        SELECT count FROM burst_bucket
        WHERE scope = ${b.scope}::text AND key = ${b.key}::text AND window_start = ${b.previousStart.toISOString()}::timestamptz
      ), 0)::float8 * ${weight}::float8 AS weighted
    )
    INSERT INTO burst_bucket AS c (scope, key, window_start, count)
    SELECT ${b.scope}::text, ${b.key}::text, ${b.windowStart.toISOString()}::timestamptz, 1
    FROM prev WHERE 1 + prev.weighted <= ${b.limit}::float8
    ON CONFLICT (scope, key, window_start) DO UPDATE
      SET count = c.count + 1
      WHERE c.count + 1 + (SELECT weighted FROM prev) <= ${b.limit}::float8
    RETURNING c.count
  `.execute(db);
  return rows[0]?.count ?? null;
}

/** Counts of the current and previous windows (0 without a row), for `Retry-After`. */
export async function burstCounts(
  db: Database,
  { scope, key, windowStart, previousStart }: Pick<ConsumeBurst, "scope" | "key" | "windowStart" | "previousStart">,
): Promise<{ current: number; previous: number }> {
  const { rows } = await sql<{ window_start: Date | string; count: number }>`
    SELECT window_start, count FROM burst_bucket
    WHERE scope = ${scope}::text AND key = ${key}::text
      AND window_start IN (${windowStart.toISOString()}::timestamptz, ${previousStart.toISOString()}::timestamptz)
  `.execute(db);
  let current = 0;
  let previous = 0;
  for (const r of rows) {
    if (new Date(r.window_start).getTime() === windowStart.getTime()) current = r.count;
    else previous = r.count;
  }
  return { current, previous };
}

/**
 * Unconditional counterpart of `tryConsumeBurst` for log-only mode: count the
 * request in the current window whether or not the limit is exceeded.
 */
export async function addBurst(db: Database, b: Pick<ConsumeBurst, "scope" | "key" | "windowStart">): Promise<void> {
  await sql`
    INSERT INTO burst_bucket AS c (scope, key, window_start, count)
    VALUES (${b.scope}::text, ${b.key}::text, ${b.windowStart.toISOString()}::timestamptz, 1)
    ON CONFLICT (scope, key, window_start) DO UPDATE SET count = c.count + 1
  `.execute(db);
}
