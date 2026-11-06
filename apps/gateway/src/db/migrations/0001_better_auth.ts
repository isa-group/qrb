/**
 * Better Auth's tables: core (user, session, account, verification) plus the
 * anonymous plugin (`user.isAnonymous`), the API-key plugin (`apikey`) and
 * database-backed rate limiting (`rateLimit`). GitHub, ORCID (generic OAuth)
 * and CAPTCHA add no tables.
 *
 * `up` runs `0001_better_auth.sql`, generated verbatim by Better Auth's CLI
 * from `../auth-schema.config.ts` (`task gateway:auth:generate`). The db test
 * checks that Better Auth sees nothing left to migrate afterwards.
 */
import { readFileSync } from "node:fs";
import { sql, type Kysely } from "kysely";

const SQL_FILE = new URL("./0001_better_auth.sql", import.meta.url);

/** Split the generated file into single statements (PGlite's extended
 * protocol, like any parameterised query, runs one statement at a time). */
function statements(text: string): string[] {
  return text
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.replace(/^\s*--.*$/gm, "").trim())
    .filter(Boolean);
}

export async function up(db: Kysely<any>): Promise<void> {
  for (const stmt of statements(readFileSync(SQL_FILE, "utf8"))) {
    await sql.raw(stmt).execute(db);
  }
}

export async function down(db: Kysely<any>): Promise<void> {
  // Reverse dependency order: session, account and apikey reference user
  // (apikey only logically, via referenceId).
  for (const table of ["rateLimit", "apikey", "verification", "account", "session", "user"]) {
    await db.schema.dropTable(table).execute();
  }
}
