/**
 * Per-account quota overrides, set from the admin page (`../admin.ts`).
 *
 * A row in `quota_override` replaces the `signed_in` tier's daily units for that account (more
 * for a heavy research user, fewer, or 0 to pause one without banning it). Keyless callers
 * (`ip:<address>`) never have one. The override applies to the browser session and the API key
 * alike, since both are charged to the owner's `userId`.
 *
 * Reads are cached for `CACHE_MS` per account: every counted request needs the quota, and
 * overrides change rarely. The gateway runs as a single instance, and setting or clearing an
 * override through this module drops the cached value at once.
 */
import { sql } from "kysely";
import type { Database } from "../db";
import type { LimitsConfig, Tier } from "./config";

const CACHE_MS = 60_000;
const cache = new Map<string, { units: number | null; until: number }>();

export interface QuotaOverride {
  userId: string;
  dailyUnits: number;
  reason: string;
  setBy: string;
  setAt: string;
}

/** The account's override in daily units, or null. Cached (see module doc). */
export async function overrideUnits(db: Database, userId: string, now: number = Date.now()): Promise<number | null> {
  const hit = cache.get(userId);
  if (hit && hit.until > now) return hit.units;
  const row = await db.selectFrom("quota_override").select("daily_units").where("user_id", "=", userId).executeTakeFirst();
  const units = row ? Number(row.daily_units) : null;
  cache.set(userId, { units, until: now + CACHE_MS });
  return units;
}

/** Daily units of `userId` on `tier`: the account's override if any, else the tier's quota. */
export async function dailyQuota(db: Database, config: LimitsConfig, userId: string, tier: Tier): Promise<number> {
  if (tier !== "signed_in") return config.dailyUnits[tier];
  return (await overrideUnits(db, userId)) ?? config.dailyUnits[tier];
}

export async function getQuotaOverride(db: Database, userId: string): Promise<QuotaOverride | null> {
  const row = await db.selectFrom("quota_override").selectAll().where("user_id", "=", userId).executeTakeFirst();
  return row
    ? { userId: row.user_id, dailyUnits: Number(row.daily_units), reason: row.reason, setBy: row.set_by, setAt: new Date(row.set_at).toISOString() }
    : null;
}

export async function setQuotaOverride(db: Database, o: { userId: string; dailyUnits: number; reason: string; setBy: string }): Promise<void> {
  await sql`
    INSERT INTO quota_override (user_id, daily_units, reason, set_by)
    VALUES (${o.userId}, ${o.dailyUnits}, ${o.reason}, ${o.setBy})
    ON CONFLICT (user_id) DO UPDATE
      SET daily_units = EXCLUDED.daily_units, reason = EXCLUDED.reason, set_by = EXCLUDED.set_by, set_at = now()`.execute(db);
  cache.delete(o.userId);
}

/** Removes the account's override; true if there was one. */
export async function clearQuotaOverride(db: Database, userId: string): Promise<boolean> {
  const res = await db.deleteFrom("quota_override").where("user_id", "=", userId).executeTakeFirst();
  cache.delete(userId);
  return Number(res.numDeletedRows) > 0;
}

/** Better Auth `databaseHooks.user.delete.after`: a deleted user's override goes with them. */
export function deleteQuotaOverrideOfUser(db: Database) {
  return async (user: { id: string }): Promise<void> => {
    await clearQuotaOverride(db, user.id);
  };
}
