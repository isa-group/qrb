/**
 * Migration command (see `task gateway:migrate` / `gateway:migrate:down`).
 *
 *   bun src/db/migrate.ts up          apply all pending migrations
 *   bun src/db/migrate.ts down        roll back the latest migration
 *   bun src/db/migrate.ts down --all  roll back every migration
 *
 * Uses DATABASE_URL, or PGlite (PGLITE_DATA_DIR) outside production.
 */
import { configFromEnv, createDatabase } from "./index";
import { migrateDown, migrateUp } from "./migrator";

const [command = "up", ...flags] = process.argv.slice(2);
if (command !== "up" && command !== "down") {
  console.error(`usage: migrate.ts up | down [--all]   (got "${command}")`);
  process.exit(2);
}

const config = configFromEnv();
if (config.kind === "pglite" && !config.dataDir) {
  console.error("No DATABASE_URL or PGLITE_DATA_DIR set: refusing to migrate a throwaway in-memory database.");
  process.exit(2);
}
const db = createDatabase(config);
try {
  const { results = [] } =
    command === "up" ? await migrateUp(db) : await migrateDown(db, { all: flags.includes("--all") });
  if (results.length === 0) console.log("nothing to do");
  for (const r of results) console.log(`${r.direction.toLowerCase()} ${r.migrationName}: ${r.status}`);
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await db.destroy();
}
