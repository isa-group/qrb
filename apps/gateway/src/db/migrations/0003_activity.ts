/**
 * Activity of signed-in accounts, shown on the website's Account page and kept 30 days.
 *
 * request_log: one row per counted request (one that cost units) of a signed-in
 *   user, from the browser session or the API key. `cost` is what the request
 *   finally cost (0 after a refunded 5xx). `api_key_id` / `api_key_start` say
 *   which key, if any; the start survives revoking the key. Keyless callers
 *   (identified by IP) are never logged.
 *
 * bind_history: one row per signed-in `POST /select` that answered 200: the
 *   request as sent (`request`: circuit, preferences, shots, live,
 *   force_refresh) and a summary of the answer (`summary`: winners, candidate
 *   count, feasibility, data source). Deleted by the user, or after 30 days.
 *
 * No foreign key to "user": like the quota counters, the activity tables do
 * not depend on auth rows; deleting a user deletes them through
 * `databaseHooks.user.delete` (see `../../auth`).
 */
import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("request_log")
    .addColumn("id", "bigserial", (c) => c.primaryKey())
    .addColumn("user_id", "text", (c) => c.notNull())
    .addColumn("api_key_id", "text")
    .addColumn("api_key_start", "text")
    .addColumn("method", "text", (c) => c.notNull())
    .addColumn("path", "text", (c) => c.notNull())
    .addColumn("cost", "integer", (c) => c.notNull().check(sql`cost >= 0`))
    .addColumn("status", "integer", (c) => c.notNull())
    .addColumn("duration_ms", "integer", (c) => c.notNull())
    .addColumn("at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema.createIndex("request_log_user_id_idx").on("request_log").columns(["user_id", "id"]).execute();
  await db.schema.createIndex("request_log_at_idx").on("request_log").column("at").execute();

  await db.schema
    .createTable("bind_history")
    .addColumn("id", "bigserial", (c) => c.primaryKey())
    .addColumn("user_id", "text", (c) => c.notNull())
    .addColumn("api_key_id", "text")
    .addColumn("api_key_start", "text")
    .addColumn("cost", "integer", (c) => c.notNull())
    .addColumn("request", "jsonb", (c) => c.notNull())
    .addColumn("summary", "jsonb", (c) => c.notNull())
    .addColumn("at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema.createIndex("bind_history_user_id_idx").on("bind_history").columns(["user_id", "id"]).execute();
  await db.schema.createIndex("bind_history_at_idx").on("bind_history").column("at").execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("bind_history").execute();
  await db.schema.dropTable("request_log").execute();
}
