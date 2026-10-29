import type { Migration } from "kysely/migration";
import * as m0001 from "./0001_better_auth";
import * as m0002 from "./0002_quota_counters";

/**
 * All gateway migrations, in order. Listed statically (not read from the
 * directory) so they work the same under `bun test`, `bun run` and a bundled
 * build. Names are sorted by Kysely; keep the numeric prefix.
 */
export const migrations: Record<string, Migration> = {
  "0001_better_auth": m0001,
  "0002_quota_counters": m0002,
};
