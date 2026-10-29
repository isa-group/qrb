/**
 * Gateway database: one Kysely instance shared by Better Auth and the
 * gateway's own quota and rate-limit code.
 *
 * - Production: real Postgres through `pg` (`DATABASE_URL`).
 * - Tests and local dev without a Postgres server: PGlite, which is real
 *   Postgres compiled to WASM and runs in-process. Same SQL, same planner,
 *   same `ON CONFLICT` semantics, so tests exercise the production SQL.
 *
 * Better Auth accepts a Kysely instance as `database: { db, type: "postgres" }`
 * (see `betterAuthDatabase`), so both dialects go through the same adapter.
 */
import { PGlite } from "@electric-sql/pglite";
import { Kysely, PGliteDialect, PostgresDialect, type Generated } from "kysely";
import pg from "pg";

/** Postgres type OIDs whose default JS parsing we override. */
const DATE_OID = 1082;

/** Daily resolve units per user (anonymous or signed in), keyed by UTC day. */
export interface QuotaUserDailyTable {
  user_id: string;
  /** UTC day as `YYYY-MM-DD`. Returned as a string, never a JS Date. */
  day: string;
  units_used: Generated<number>;
  updated_at: Generated<Date>;
}

/** Daily resolve units for all anonymous identities at one client IP. */
export interface QuotaIpDailyTable {
  ip: string;
  day: string;
  units_used: Generated<number>;
  updated_at: Generated<Date>;
}

/** Fixed-window counters, combined into a sliding window by the limiter. */
export interface BurstBucketTable {
  scope: string;
  key: string;
  window_start: Date;
  count: Generated<number>;
}

/** Tables owned by the gateway. Better Auth's tables are typed by Better Auth. */
export interface GatewayTables {
  quota_user_daily: QuotaUserDailyTable;
  quota_ip_daily: QuotaIpDailyTable;
  burst_bucket: BurstBucketTable;
}

export type Database = Kysely<GatewayTables>;

export type DatabaseConfig =
  | { kind: "postgres"; url: string; maxConnections?: number }
  /** `dataDir` undefined means in-memory (lost on close). */
  | { kind: "pglite"; dataDir?: string };

/**
 * `DATABASE_URL` may be written in SQLAlchemy form
 * (`postgresql+psycopg://...`) because `packages/qrb-store` shares the same
 * variable and database. `pg` needs the plain scheme.
 */
export function normalizePostgresUrl(url: string): string {
  return url.replace(/^postgres(?:ql)?\+[a-z0-9_]+:\/\//i, "postgresql://");
}

/**
 * Resolve the database from the environment:
 * - `DATABASE_URL` set: Postgres.
 * - otherwise, outside production: PGlite, persisted in `PGLITE_DATA_DIR` if
 *   set, else in memory.
 * - otherwise (production without `DATABASE_URL`): error, so a misconfigured
 *   deployment never silently runs on a throwaway database.
 */
export function configFromEnv(env: Record<string, string | undefined> = process.env): DatabaseConfig {
  const url = env.DATABASE_URL?.trim();
  if (url) return { kind: "postgres", url: normalizePostgresUrl(url) };
  if (env.NODE_ENV === "production") {
    throw new Error("DATABASE_URL must be set in production (the gateway needs Postgres).");
  }
  const dataDir = env.PGLITE_DATA_DIR?.trim();
  return { kind: "pglite", dataDir: dataDir || undefined };
}

export function createDatabase(config: DatabaseConfig): Database {
  if (config.kind === "postgres") {
    const pool = new pg.Pool({
      connectionString: config.url,
      max: config.maxConnections ?? 10,
      // Keep DATE columns as `YYYY-MM-DD` strings. The default parser builds a
      // JS Date at *local* midnight, which shifts UTC days.
      types: {
        getTypeParser: ((oid: number, format?: "text" | "binary") =>
          oid === DATE_OID ? (v: string) => v : pg.types.getTypeParser(oid, format as "text")) as typeof pg.types.getTypeParser,
      },
    });
    return new Kysely<GatewayTables>({ dialect: new PostgresDialect({ pool }) });
  }
  // Single options object: `new PGlite(undefined, opts)` silently drops opts.
  const pglite = new PGlite({
    dataDir: config.dataDir,
    parsers: { [DATE_OID]: (v: string) => v },
  });
  return new Kysely<GatewayTables>({ dialect: new PGliteDialect({ pglite }) });
}

/** Fresh in-memory PGlite database, for tests. */
export function createTestDatabase(): Database {
  return createDatabase({ kind: "pglite" });
}

/**
 * The `database` option for `betterAuth(...)`, sharing the gateway's Kysely
 * instance (and so its pool or PGlite instance). `transaction: true` lets
 * Better Auth wrap multi-step writes (e.g. user + account on sign-up).
 */
export function betterAuthDatabase(db: Database) {
  return { db: db as Kysely<any>, type: "postgres" as const, transaction: true };
}
