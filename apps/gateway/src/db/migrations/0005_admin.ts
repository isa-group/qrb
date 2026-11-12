/**
 * Admin: Better Auth's `admin` plugin columns, the admin audit log and per-user quota overrides.
 *
 * - `user.role` / `banned` / `banReason` / `banExpires` and `session.impersonatedBy`: exactly
 *   what `task gateway:auth:generate` emits for the plugin (see `../auth-schema.ts`).
 *   Impersonation is never exposed (its routes are disabled), but the column is part of the
 *   plugin's schema and Better Auth checks the schema is complete.
 * - `admin_audit`: append-only record of every admin action (who, what, on whom, from where).
 *   The gateway only ever INSERTs and SELECTs it.
 * - `quota_override`: a signed-in account's daily units, replacing the tier's quota
 *   (`limits/quota.ts`). Deleted with the user (`databaseHooks.user.delete`).
 *
 * Like the activity tables, the admin tables have no foreign key to "user": audit rows outlive
 * the accounts they mention.
 */
import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    ALTER TABLE "user"
      ADD COLUMN "role" text,
      ADD COLUMN "banned" boolean,
      ADD COLUMN "banReason" text,
      ADD COLUMN "banExpires" timestamptz`.execute(db);
  await sql`ALTER TABLE "session" ADD COLUMN "impersonatedBy" text`.execute(db);

  await db.schema
    .createTable("admin_audit")
    .addColumn("id", "bigserial", (c) => c.primaryKey())
    .addColumn("actor_id", "text", (c) => c.notNull())
    .addColumn("action", "text", (c) => c.notNull())
    .addColumn("target_user_id", "text")
    .addColumn("details", "jsonb", (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn("ip", "text")
    .addColumn("at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema.createIndex("admin_audit_target_idx").on("admin_audit").columns(["target_user_id", "id"]).execute();

  await db.schema
    .createTable("quota_override")
    .addColumn("user_id", "text", (c) => c.primaryKey())
    .addColumn("daily_units", "integer", (c) => c.notNull().check(sql`daily_units >= 0`))
    .addColumn("reason", "text", (c) => c.notNull())
    .addColumn("set_by", "text", (c) => c.notNull())
    .addColumn("set_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("quota_override").execute();
  await db.schema.dropTable("admin_audit").execute();
  await sql`ALTER TABLE "session" DROP COLUMN "impersonatedBy"`.execute(db);
  await sql`
    ALTER TABLE "user"
      DROP COLUMN "role", DROP COLUMN "banned", DROP COLUMN "banReason", DROP COLUMN "banExpires"`.execute(db);
}
