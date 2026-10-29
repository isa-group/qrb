import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { sql } from "kysely";
import { authSchemaOptions } from "../src/db/auth-schema";
import { tryConsumeDailyUnits } from "../src/db/counters";
import {
  betterAuthDatabase,
  configFromEnv,
  createTestDatabase,
  normalizePostgresUrl,
  type Database,
} from "../src/db";
import { MIGRATION_LOCK_TABLE, MIGRATION_TABLE, migrateDown, migrateUp } from "../src/db/migrator";

const AUTH_TABLES = ["user", "session", "account", "verification", "apikey", "rateLimit"];
const GATEWAY_TABLES = ["quota_user_daily", "quota_ip_daily", "burst_bucket"];
const BOOKKEEPING = [MIGRATION_TABLE, MIGRATION_LOCK_TABLE];

async function publicTables(db: Database): Promise<string[]> {
  const { rows } = await sql<{ table_name: string }>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' ORDER BY table_name`.execute(db);
  return rows.map((r) => r.table_name);
}

async function publicIndexes(db: Database): Promise<string[]> {
  const { rows } = await sql<{ indexname: string }>`
    SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`.execute(db);
  return rows.map((r) => r.indexname);
}

let db: Database;
beforeEach(() => {
  db = createTestDatabase();
});
afterEach(async () => {
  await db.destroy();
});

describe("migrations", () => {
  test("apply to an empty database and create every expected table", async () => {
    expect(await publicTables(db)).toEqual([]);

    const { results } = await migrateUp(db);
    expect(results?.map((r) => [r.migrationName, r.status])).toEqual([
      ["0001_better_auth", "Success"],
      ["0002_quota_counters", "Success"],
    ]);

    expect(await publicTables(db)).toEqual([...AUTH_TABLES, ...GATEWAY_TABLES, ...BOOKKEEPING].sort());
    expect(await publicIndexes(db)).toEqual(
      expect.arrayContaining([
        "apikey_key_idx",
        "apikey_referenceId_idx",
        "session_userId_idx",
        "quota_user_daily_pkey",
        "quota_user_daily_day_idx",
        "quota_ip_daily_pkey",
        "quota_ip_daily_day_idx",
        "burst_bucket_pkey",
        "burst_bucket_window_start_idx",
      ]),
    );

    // Running again is a no-op.
    expect((await migrateUp(db)).results).toEqual([]);
  });

  test("leave Better Auth nothing to migrate for the planned plugin set", async () => {
    await migrateUp(db);
    const options = {
      ...authSchemaOptions,
      secret: "test-secret-test-secret-test-secret",
      baseURL: "http://localhost:3001",
      database: betterAuthDatabase(db),
    };
    const plan = await getMigrations(options, { throwOnUnsafe: false });
    expect(plan.toBeCreated.map((t) => t.table)).toEqual([]);
    expect(plan.toBeAdded.map((t) => [t.table, Object.keys(t.fields)])).toEqual([]);
    expect(plan.toBeAddedIndexes.map((i) => i.name)).toEqual([]);

    // And Better Auth can write through the shared Kysely instance: an
    // anonymous sign-in creates a user (isAnonymous) and a session row.
    const auth = betterAuth(options);
    const { user } = await auth.api.signInAnonymous({ headers: new Headers() });
    const users = await sql<{ isAnonymous: boolean | null }>`
      SELECT "isAnonymous" FROM "user" WHERE id = ${user.id}`.execute(db);
    expect(users.rows).toEqual([{ isAnonymous: true }]);
    const sessions = await sql`SELECT id FROM "session" WHERE "userId" = ${user.id}`.execute(db);
    expect(sessions.rows.length).toBe(1);
  });

  test("roll back one step at a time, then fully, leaving no tables behind", async () => {
    await migrateUp(db);

    const step = await migrateDown(db);
    expect(step.results?.map((r) => [r.migrationName, r.direction, r.status])).toEqual([
      ["0002_quota_counters", "Down", "Success"],
    ]);
    expect(await publicTables(db)).toEqual([...AUTH_TABLES, ...BOOKKEEPING].sort());

    await migrateUp(db);
    const all = await migrateDown(db, { all: true });
    expect(all.results?.map((r) => r.migrationName)).toEqual(["0002_quota_counters", "0001_better_auth"]);

    // Only Kysely's own bookkeeping remains, and it records nothing applied.
    expect(await publicTables(db)).toEqual([...BOOKKEEPING].sort());
    const { rows } = await sql`SELECT * FROM ${sql.table(MIGRATION_TABLE)}`.execute(db);
    expect(rows).toEqual([]);
    expect((await publicIndexes(db)).filter((i) => !i.startsWith(MIGRATION_TABLE))).toEqual([]);

    // A rolled-back database migrates up again cleanly.
    expect((await migrateUp(db)).results?.every((r) => r.status === "Success")).toBe(true);
  });
});

describe("conditional consume statement", () => {
  const day = "2026-10-28";

  beforeEach(async () => {
    await migrateUp(db);
  });

  test("consumes only while used + n <= quota, in one statement", async () => {
    const consume = (units: number) =>
      tryConsumeDailyUnits(db, { table: "quota_user_daily", key: "u1", day, units, quota: 10 });

    expect(await consume(11)).toBeNull(); // first request over quota: no row written
    expect(await db.selectFrom("quota_user_daily").selectAll().execute()).toEqual([]);

    expect(await consume(5)).toBe(5); // insert path
    expect(await consume(4)).toBe(9); // update path
    expect(await consume(2)).toBeNull(); // 11 > 10: rejected, unchanged
    expect(await consume(1)).toBe(10); // exactly at the quota
    expect(await consume(1)).toBeNull();

    const row = await db.selectFrom("quota_user_daily").selectAll().executeTakeFirstOrThrow();
    expect(row).toMatchObject({ user_id: "u1", day, units_used: 10 });
  });

  test("parallel consumers never overshoot the quota", async () => {
    // 50 concurrent 3-unit requests against a 20-unit quota: exactly 6 fit.
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        tryConsumeDailyUnits(db, { table: "quota_user_daily", key: "u2", day, units: 3, quota: 20 }),
      ),
    );
    const accepted = results.filter((r) => r !== null);
    expect(accepted.length).toBe(6);
    expect(new Set(accepted)).toEqual(new Set([3, 6, 9, 12, 15, 18]));
    const row = await db.selectFrom("quota_user_daily").select("units_used").executeTakeFirstOrThrow();
    expect(row.units_used).toBe(18);
  });

  test("keys and days are independent, and the IP table uses the same statement", async () => {
    const ip = (key: string, d: string) =>
      tryConsumeDailyUnits(db, { table: "quota_ip_daily", key, day: d, units: 1, quota: 1 });
    expect(await ip("203.0.113.7", day)).toBe(1);
    expect(await ip("203.0.113.7", day)).toBeNull();
    expect(await ip("203.0.113.8", day)).toBe(1);
    expect(await ip("203.0.113.7", "2026-10-29")).toBe(1);
  });

  test("the units_used >= 0 check rejects a refund below zero", async () => {
    await tryConsumeDailyUnits(db, { table: "quota_user_daily", key: "u3", day, units: 1, quota: 5 });
    await expect(
      db.updateTable("quota_user_daily").set({ units_used: sql`units_used - 2` }).where("user_id", "=", "u3").execute(),
    ).rejects.toThrow();
  });

  test("rejects non-integer or non-positive units", async () => {
    await expect(
      tryConsumeDailyUnits(db, { table: "quota_user_daily", key: "u", day, units: 0, quota: 5 }),
    ).rejects.toThrow(RangeError);
  });
});

describe("configuration", () => {
  test("DATABASE_URL selects Postgres and accepts the SQLAlchemy form", () => {
    expect(configFromEnv({ DATABASE_URL: "postgresql+psycopg://qrb:qrb@localhost:5432/qrb" })).toEqual({
      kind: "postgres",
      url: "postgresql://qrb:qrb@localhost:5432/qrb",
    });
    expect(normalizePostgresUrl("postgres://a@b/c")).toBe("postgres://a@b/c");
  });

  test("without DATABASE_URL: PGlite outside production, an error in production", () => {
    expect(configFromEnv({})).toEqual({ kind: "pglite", dataDir: undefined });
    expect(configFromEnv({ PGLITE_DATA_DIR: "./.data/pglite" })).toEqual({
      kind: "pglite",
      dataDir: "./.data/pglite",
    });
    expect(() => configFromEnv({ NODE_ENV: "production" })).toThrow(/DATABASE_URL/);
  });
});
