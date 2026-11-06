/**
 * Async binds (`POST /api/binds`, `GET /api/binds/:id`) are stored in `bind_history`, so the
 * Account page lists them with the synchronous ones.
 *
 * - `public_id`: the id callers poll with (a random UUID; the bigserial `id` stays internal).
 * - `status`: `pending` while the API is resolving, then `done` or `failed`. Rows written by a
 *   synchronous `/select` are `done`.
 * - `summary` is null until a bind is done.
 * - `response`: the full `/select` envelope of a done async bind, returned by `GET /api/binds/:id`.
 * - `error`: why a failed bind failed.
 * - `quota_day`: the UTC day its units were taken from, to refund them after a gateway restart.
 */
import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    ALTER TABLE bind_history
      ADD COLUMN public_id uuid UNIQUE,
      ADD COLUMN status text NOT NULL DEFAULT 'done' CHECK (status IN ('pending', 'done', 'failed')),
      ADD COLUMN finished_at timestamptz,
      ADD COLUMN response jsonb,
      ADD COLUMN error text,
      ADD COLUMN quota_day text,
      ALTER COLUMN summary DROP NOT NULL`.execute(db);
  await sql`CREATE INDEX bind_history_pending_idx ON bind_history (user_id) WHERE status = 'pending'`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DELETE FROM bind_history WHERE summary IS NULL`.execute(db);
  await sql`DROP INDEX bind_history_pending_idx`.execute(db);
  await sql`
    ALTER TABLE bind_history
      DROP COLUMN public_id, DROP COLUMN status, DROP COLUMN finished_at,
      DROP COLUMN response, DROP COLUMN error, DROP COLUMN quota_day,
      ALTER COLUMN summary SET NOT NULL`.execute(db);
}
