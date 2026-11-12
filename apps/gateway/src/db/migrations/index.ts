import type { Migration } from "kysely/migration";
import * as m0001 from "./0001_better_auth";
import * as m0002 from "./0002_quota_counters";
import * as m0003 from "./0003_activity";
import * as m0004 from "./0004_async_binds";
import * as m0005 from "./0005_admin";

/**
 * All gateway migrations, in order. Listed statically (not read from the
 * directory) so they work the same under `bun test`, `bun run` and a bundled
 * build. Names are sorted by Kysely; keep the numeric prefix.
 */
export const migrations: Record<string, Migration> = {
  "0001_better_auth": m0001,
  "0002_quota_counters": m0002,
  "0003_activity": m0003,
  "0004_async_binds": m0004,
  "0005_admin": m0005,
};
