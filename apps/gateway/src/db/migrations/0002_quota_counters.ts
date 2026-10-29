/**
 * Gateway-owned counters for quotas (task 4.1) and rate limits (task 4.3).
 *
 * quota_user_daily (user_id, day) -> units_used
 *   Daily resolve units per user, anonymous or signed in; API keys charge
 *   their owner's user_id. `day` is the UTC date. Consumption is a single
 *   conditional upsert (see `../counters.ts`): the row is created or
 *   incremented only if `units_used + n <= quota`, so concurrent requests can
 *   never overshoot. No foreign key to "user": the quota engine must not
 *   depend on auth rows existing, and deleting an anonymous user (Better Auth
 *   does that after linking) must not erase the day's usage before it has
 *   been carried over.
 *
 * quota_ip_daily (ip, day) -> units_used
 *   Daily cap shared by all anonymous identities at one client IP. `ip` is
 *   text so task 4.3 chooses normalisation (e.g. an IPv6 /64 prefix).
 *
 * burst_bucket (scope, key, window_start) -> count
 *   Fixed-window counters for a sliding-window limiter: the estimate for
 *   "now" is count(current) + count(previous) * (1 - elapsed / window).
 *   `scope` names the limit and implies its window length (e.g.
 *   "burst:user:60s", "burst:apikey:60s", "open:ip:60s"); `key` is the user
 *   id, API key id or IP. `window_start` = now truncated to the window.
 *
 * Retention: rows are only needed for the current UTC day (quotas) or the
 * current and previous window (bursts), plus whatever the usage endpoint
 * reports. Old rows can be deleted at any time, e.g. daily:
 *   DELETE FROM quota_user_daily WHERE day < current_date - 7;
 *   DELETE FROM quota_ip_daily   WHERE day < current_date - 7;
 *   DELETE FROM burst_bucket     WHERE window_start < now() - interval '1 hour';
 * The `*_day_idx` / `burst_bucket_window_start_idx` indexes serve these
 * deletes; lookups use the primary keys.
 */
import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("quota_user_daily")
    .addColumn("user_id", "text", (c) => c.notNull())
    .addColumn("day", "date", (c) => c.notNull())
    .addColumn("units_used", "integer", (c) => c.notNull().defaultTo(0).check(sql`units_used >= 0`))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint("quota_user_daily_pkey", ["user_id", "day"])
    .execute();
  await db.schema.createIndex("quota_user_daily_day_idx").on("quota_user_daily").column("day").execute();

  await db.schema
    .createTable("quota_ip_daily")
    .addColumn("ip", "text", (c) => c.notNull())
    .addColumn("day", "date", (c) => c.notNull())
    .addColumn("units_used", "integer", (c) => c.notNull().defaultTo(0).check(sql`units_used >= 0`))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint("quota_ip_daily_pkey", ["ip", "day"])
    .execute();
  await db.schema.createIndex("quota_ip_daily_day_idx").on("quota_ip_daily").column("day").execute();

  await db.schema
    .createTable("burst_bucket")
    .addColumn("scope", "text", (c) => c.notNull())
    .addColumn("key", "text", (c) => c.notNull())
    .addColumn("window_start", "timestamptz", (c) => c.notNull())
    .addColumn("count", "integer", (c) => c.notNull().defaultTo(0).check(sql`count >= 0`))
    .addPrimaryKeyConstraint("burst_bucket_pkey", ["scope", "key", "window_start"])
    .execute();
  await db.schema
    .createIndex("burst_bucket_window_start_idx")
    .on("burst_bucket")
    .column("window_start")
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("burst_bucket").execute();
  await db.schema.dropTable("quota_ip_daily").execute();
  await db.schema.dropTable("quota_user_daily").execute();
}
