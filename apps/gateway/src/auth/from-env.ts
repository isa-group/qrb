import { configFromEnv, createDatabase } from "../db";
import { migrateUp } from "../db/migrator";
import { authConfigFromEnv } from "./config";
import { authGetter, createAuth, type GatewayAuth } from "./index";

let shared: (() => Promise<GatewayAuth>) | undefined;

/**
 * The process-wide auth instance built from the environment.
 *
 * Configuration (auth and database) is validated immediately, so a production
 * process with a missing `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, OAuth
 * credentials or `DATABASE_URL` fails at startup. The database connection is
 * opened on first use.
 *
 * Postgres migrations are applied explicitly (`task gateway:db:migrate`). A
 * PGlite database (local development without Postgres) is migrated on first
 * use, since an in-memory one starts empty every run.
 */
export function authFromEnv(env: Record<string, string | undefined> = process.env): () => Promise<GatewayAuth> {
  if (shared) return shared;
  const authConfig = authConfigFromEnv(env);
  const dbConfig = configFromEnv(env);
  shared = authGetter(async () => {
    const db = createDatabase(dbConfig);
    if (dbConfig.kind === "pglite") await migrateUp(db);
    return createAuth(db, authConfig);
  });
  return shared;
}
