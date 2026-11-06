/**
 * Config file for Better Auth's CLI only (`task gateway:auth:generate`).
 *
 * The Kysely generator introspects a live database and emits only the
 * difference. Pointing it at an empty in-memory PGlite (real Postgres) makes
 * it emit the complete schema, with no Postgres server or DATABASE_URL.
 */
import { betterAuth } from "better-auth";
import { authSchemaOptions } from "./auth-schema";
import { betterAuthDatabase, createTestDatabase } from "./index";

export const auth = betterAuth({
  ...authSchemaOptions,
  secret: "schema-only-secret-schema-only-secret",
  database: betterAuthDatabase(createTestDatabase()),
});
