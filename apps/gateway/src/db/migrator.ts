import { Migrator, NO_MIGRATIONS, type MigrationResultSet } from "kysely/migration";
import type { Kysely } from "kysely";
import { migrations } from "./migrations";

/** Bookkeeping tables, named so they are not confused with Alembic's
 * `alembic_version` (packages/qrb-store) when both share one database. */
export const MIGRATION_TABLE = "gateway_migration";
export const MIGRATION_LOCK_TABLE = "gateway_migration_lock";

export function createMigrator(db: Kysely<any>): Migrator {
  return new Migrator({
    db,
    provider: { getMigrations: async () => migrations },
    migrationTableName: MIGRATION_TABLE,
    migrationLockTableName: MIGRATION_LOCK_TABLE,
  });
}

function unwrap(result: MigrationResultSet): MigrationResultSet {
  if (result.error) {
    const failed = result.results?.find((r) => r.status === "Error");
    const where = failed ? ` (in ${failed.migrationName})` : "";
    throw new Error(`migration failed${where}: ${String(result.error)}`, { cause: result.error });
  }
  return result;
}

/** Apply every pending migration. Each runs in its own transaction
 * (Postgres has transactional DDL), so a failure leaves no partial step. */
export async function migrateUp(db: Kysely<any>): Promise<MigrationResultSet> {
  return unwrap(await createMigrator(db).migrateToLatest());
}

/** Roll back the most recent migration, or all of them with `all`. */
export async function migrateDown(db: Kysely<any>, opts: { all?: boolean } = {}): Promise<MigrationResultSet> {
  const migrator = createMigrator(db);
  return unwrap(opts.all ? await migrator.migrateTo(NO_MIGRATIONS) : await migrator.migrateDown());
}
