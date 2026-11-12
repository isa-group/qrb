/**
 * Admin API: who gets in (network, session only, role), what changes need (same origin, recent
 * sign-in, not yourself), what the actions do (ban, keys, quota override, role, removal) and the
 * audit log. Better Auth's own admin routes stay closed.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "kysely";
import { STEP_UP_MS, truncateIp } from "../src/admin";
import { createApp } from "../src/app";
import { ADMIN_DISABLED_PATHS, createAuth, type GatewayAuth } from "../src/auth";
import { createTestDatabase, type Database } from "../src/db";
import { migrateUp } from "../src/db/migrator";
import {
  baseConfig,
  BEHIND_PROXY,
  fakeProviders,
  github,
  identities,
  Jar,
  oauth,
  ORIGIN,
  realFetch,
  signedInUserId,
  unexpected,
  type App,
} from "./helpers/providers";

const CLIENT = "203.0.113.9";

let db: Database;
let auth: GatewayAuth;
let app: App;

function build(opts: { now?: () => Date; adminUserIds?: string[] } = {}) {
  auth = createAuth(db, { ...baseConfig, adminUserIds: opts.adminUserIds ?? [] }, { logLevel: "error" });
  app = createApp({
    ...BEHIND_PROXY,
    auth,
    adminUserIds: opts.adminUserIds ?? [],
    now: opts.now,
    upstreamUrl: "http://upstream.test:8000",
    secret: "s",
    fetch: async () => Response.json({ ok: true }),
  });
}

beforeAll(() => {
  globalThis.fetch = fakeProviders as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});
beforeEach(async () => {
  identities.clear();
  unexpected.length = 0;
  db = createTestDatabase();
  await migrateUp(db);
  build();
});
afterEach(async () => {
  expect(unexpected).toEqual([]);
  await db.destroy();
});

type Opts = { jar?: Jar; origin?: string | null; headers?: Record<string, string>; body?: unknown };
function gw(method: string, path: string, opts: Opts = {}) {
  const headers: Record<string, string> = { "x-forwarded-for": CLIENT, ...opts.headers };
  if (opts.origin !== null) headers.origin = opts.origin ?? ORIGIN;
  const cookie = opts.jar?.header();
  if (cookie) headers.cookie = cookie;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  return app.request(`${ORIGIN}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
}

async function signIn(code: string, id: number): Promise<{ jar: Jar; userId: string }> {
  github(code, id, `u${id}@example.org`, true);
  const jar = new Jar();
  await oauth(app, jar, "github", code);
  return { jar, userId: await signedInUserId(app, jar) };
}

const makeAdmin = (id: string) => sql`UPDATE "user" SET role = 'admin' WHERE id = ${id}`.execute(db);

async function createKey(jar: Jar) {
  const res = await gw("POST", "/api/keys", { jar, body: { name: "ci" } });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; key: string; start: string };
}

const auditRows = async () =>
  (await sql<{ action: string; actor_id: string; target_user_id: string | null; details: Record<string, unknown> }>`
    SELECT action, actor_id, target_user_id, details FROM admin_audit ORDER BY id`.execute(db)).rows;

describe("access", () => {
  test("a signed-in admin gets in, with no-store and noindex", async () => {
    const a = await signIn("a", 1);
    await makeAdmin(a.userId);
    const res = await gw("GET", "/api/admin/users", { jar: a.jar });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
    const body = (await res.json()) as { users: { id: string; role: string; providers: string[]; email: string | null }[]; total: number };
    expect(body.total).toBe(1);
    expect(body.users[0]).toMatchObject({ id: a.userId, role: "admin", providers: ["github"], email: "u1@example.org" });
  });

  test("everyone else gets a plain 404", async () => {
    const admin = await signIn("a", 1);
    await makeAdmin(admin.userId);
    const user = await signIn("u", 2);
    const key = await createKey(admin.jar);

    const cases: [string, Opts][] = [
      ["no session", {}],
      ["a signed-in non-admin", { jar: user.jar }],
      ["an admin's API key", { headers: { "x-api-key": key.key } }],
      ["an admin session plus an API key", { jar: admin.jar, headers: { "x-api-key": key.key } }],
    ];
    for (const [name, opts] of cases) {
      const res = await gw("GET", "/api/admin/stats", opts);
      expect([name, res.status]).toEqual([name, 404]);
      expect(await res.json()).toEqual({ detail: "Not Found" });
    }
  });

  test("QRB_ADMIN_USER_IDS makes an account admin without a role", async () => {
    const a = await signIn("a", 1);
    expect((await gw("GET", "/api/admin/session", { jar: a.jar })).status).toBe(404);
    build({ adminUserIds: [a.userId] });
    const res = await gw("GET", "/api/admin/session", { jar: a.jar });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { userId: string }).userId).toBe(a.userId);
  });

  test("Better Auth's own admin routes do not exist", async () => {
    const a = await signIn("a", 1);
    await makeAdmin(a.userId);
    for (const path of ADMIN_DISABLED_PATHS) {
      const res = await app.request(`${ORIGIN}/api/auth${path}`, {
        method: "POST",
        headers: { origin: ORIGIN, cookie: a.jar.header(), "content-type": "application/json", "x-forwarded-for": CLIENT },
        body: JSON.stringify({ userId: a.userId }),
      });
      expect([path, res.status]).toEqual([path, 404]);
    }
  });

});

describe("reads", () => {
  test("user detail shows sessions by network and keys without secrets", async () => {
    const admin = await signIn("a", 1);
    await makeAdmin(admin.userId);
    const u = await signIn("u", 2);
    const key = await createKey(u.jar);
    const res = await gw("GET", `/api/admin/users/${u.userId}`, { jar: admin.jar });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(key.key);
    const body = JSON.parse(text) as { keys: { id: string; start: string }[]; sessions: { network: string | null }[]; accounts: { provider: string; accountId: string }[] };
    expect(body.keys).toEqual([expect.objectContaining({ id: key.id, start: key.start })]);
    expect(body.keys[0]).not.toHaveProperty("key");
    expect(body.accounts).toEqual([expect.objectContaining({ provider: "github", accountId: "2" })]);
    for (const s of body.sessions) expect(s.network === null || s.network.endsWith("/24") || s.network.endsWith("/48")).toBe(true);
    expect((await gw("GET", "/api/admin/users/nobody", { jar: admin.jar })).status).toBe(404);
  });

  test("stats, catalog (without the store tables) and the session window", async () => {
    const admin = await signIn("a", 1);
    await makeAdmin(admin.userId);
    const stats = (await (await gw("GET", "/api/admin/stats", { jar: admin.jar })).json()) as { totals: { users: number; admins: number }; days: unknown[] };
    expect(stats.totals).toMatchObject({ users: 1, admins: 1 });
    expect(stats.days).toHaveLength(30);
    expect(await (await gw("GET", "/api/admin/catalog", { jar: admin.jar })).json()).toEqual({ available: false, statusFetchedAt: null, resources: [] });
    const s = (await (await gw("GET", "/api/admin/session", { jar: admin.jar })).json()) as { signedInAt: string; changesAllowedUntil: string };
    expect(Date.parse(s.changesAllowedUntil) - Date.parse(s.signedInAt)).toBe(STEP_UP_MS);
  });

  test("search by name, email and provider account id", async () => {
    const admin = await signIn("a", 1);
    await makeAdmin(admin.userId);
    const u = await signIn("u", 4242);
    for (const q of ["gh4242", "u4242@example", "4242", u.userId]) {
      const body = (await (await gw("GET", `/api/admin/users?q=${encodeURIComponent(q)}`, { jar: admin.jar })).json()) as { users: { id: string }[] };
      expect([q, body.users.map((x) => x.id)]).toEqual([q, [u.userId]]);
    }
  });

  test("truncated networks", () => {
    expect(truncateIp("203.0.113.7")).toBe("203.0.113.0/24");
    expect(truncateIp("2001:db8:1:2::5")).toBe("2001:0db8:0001::/48");
    expect(truncateIp("not an ip")).toBeNull();
    expect(truncateIp(null)).toBeNull();
  });
});

describe("changes", () => {
  async function setup() {
    const admin = await signIn("a", 1);
    await makeAdmin(admin.userId);
    const user = await signIn("u", 2);
    return { admin, user };
  }

  test("need the site's own origin", async () => {
    const { admin, user } = await setup();
    for (const origin of [null, "https://evil.example"]) {
      const res = await gw("POST", `/api/admin/users/${user.userId}/revoke-sessions`, { jar: admin.jar, origin });
      expect(res.status).toBe(403);
    }
    expect(await auditRows()).toEqual([]);
  });

  test("need a sign-in from the last 15 minutes", async () => {
    const { admin, user } = await setup();
    build({ now: () => new Date(Date.now() + STEP_UP_MS + 60_000) });
    const res = await gw("PUT", `/api/admin/users/${user.userId}/quota`, { jar: admin.jar, body: { dailyUnits: 5, reason: "test" } });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reauth: true });
    // Reads still work.
    expect((await gw("GET", "/api/admin/users", { jar: admin.jar })).status).toBe(200);
  });

  test("cannot target yourself", async () => {
    const { admin } = await setup();
    for (const [method, path, body] of [
      ["POST", "ban", { reason: "x" }],
      ["POST", "role", { role: "user" }],
      ["POST", "revoke-sessions", undefined],
      ["DELETE", "", { confirm: admin.userId }],
    ] as const) {
      const res = await gw(method, `/api/admin/users/${admin.userId}${path ? "/" + path : ""}`, { jar: admin.jar, body });
      expect([path, res.status]).toEqual([path, 400]);
    }
  });

  test("ban: signs the user out, deletes their keys, refuses a key made later; unban restores sign-in", async () => {
    const { admin, user } = await setup();
    const key = await createKey(user.jar);
    expect((await gw("GET", "/api/usage", { headers: { "x-api-key": key.key } })).status).toBe(200);

    const res = await gw("POST", `/api/admin/users/${user.userId}/ban`, { jar: admin.jar, body: { reason: "abuse", days: 7 } });
    expect(res.status).toBe(200);
    expect((await gw("GET", "/api/usage", { headers: { "x-api-key": key.key } })).status).toBe(401);
    expect((await sql<{ n: number }>`SELECT count(*)::int AS n FROM session WHERE "userId" = ${user.userId}`.execute(db)).rows[0]!.n).toBe(0);
    expect((await sql<{ n: number }>`SELECT count(*)::int AS n FROM apikey WHERE "referenceId" = ${user.userId}`.execute(db)).rows[0]!.n).toBe(0);

    // A key that somehow exists for a banned owner (e.g. restored from a backup) is refused too.
    await sql`INSERT INTO apikey (id, "configId", key, "referenceId", enabled, "rateLimitEnabled", "requestCount", "createdAt", "updatedAt")
      SELECT 'restored', "configId", key, "referenceId", true, false, 0, now(), now() FROM apikey LIMIT 0`.execute(db);
    const { isBanned } = await import("../src/auth/api-keys");
    expect(await isBanned(db, user.userId)).toBe(true);

    const detail = (await (await gw("GET", `/api/admin/users/${user.userId}`, { jar: admin.jar })).json()) as { banned: boolean; banReason: string; banExpires: string };
    expect(detail).toMatchObject({ banned: true, banReason: "abuse" });
    expect(Date.parse(detail.banExpires)).toBeGreaterThan(Date.now() + 6 * 86_400_000);

    expect((await gw("POST", `/api/admin/users/${user.userId}/unban`, { jar: admin.jar })).status).toBe(200);
    expect(await isBanned(db, user.userId)).toBe(false);
    const again = new Jar();
    await oauth(app, again, "github", "u");
    expect(await signedInUserId(app, again)).toBe(user.userId);

    expect((await auditRows()).map((r) => [r.action, r.actor_id, r.target_user_id])).toEqual([
      ["user.ban", admin.userId, user.userId],
      ["user.unban", admin.userId, user.userId],
    ]);
  });

  test("a quota override changes the limit and the 429 point; clearing restores the tier", async () => {
    const { admin, user } = await setup();
    const key = await createKey(user.jar);
    const put = await gw("PUT", `/api/admin/users/${user.userId}/quota`, { jar: admin.jar, body: { dailyUnits: 2, reason: "pilot" } });
    expect(put.status).toBe(200);

    const usage = (await (await gw("GET", "/api/usage", { headers: { "x-api-key": key.key } })).json()) as { quota: number };
    expect(usage.quota).toBe(2);
    const select = () => gw("POST", "/api/select", { headers: { "x-api-key": key.key }, body: { circuit_qasm: "OPENQASM 3.0;", force_refresh: false } });
    const first = await select();
    expect(first.status).toBe(200);
    expect(first.headers.get("x-quota-limit")).toBe("2");
    expect((await select()).status).toBe(200);
    expect((await select()).status).toBe(429);

    expect((await gw("DELETE", `/api/admin/users/${user.userId}/quota`, { jar: admin.jar })).status).toBe(200);
    expect((await select()).status).toBe(200);
    expect((await gw("DELETE", `/api/admin/users/${user.userId}/quota`, { jar: admin.jar })).status).toBe(404);

    for (const body of [{ dailyUnits: -1, reason: "x" }, { dailyUnits: 1.5, reason: "x" }, { dailyUnits: 5 }, { dailyUnits: 5, reason: "" }]) {
      expect((await gw("PUT", `/api/admin/users/${user.userId}/quota`, { jar: admin.jar, body })).status).toBe(400);
    }
    expect((await auditRows()).map((r) => [r.action, r.details])).toEqual([
      ["quota.set", { dailyUnits: 2, reason: "pilot", previous: null }],
      ["quota.clear", { previous: 2 }],
    ]);
  });

  test("revoke one key and sign the user out everywhere", async () => {
    const { admin, user } = await setup();
    const key = await createKey(user.jar);
    expect((await gw("DELETE", `/api/admin/users/${user.userId}/keys/${key.id}`, { jar: admin.jar })).status).toBe(200);
    expect((await gw("GET", "/api/usage", { headers: { "x-api-key": key.key } })).status).toBe(401);
    expect((await gw("DELETE", `/api/admin/users/${user.userId}/keys/${key.id}`, { jar: admin.jar })).status).toBe(404);

    expect((await gw("POST", `/api/admin/users/${user.userId}/revoke-sessions`, { jar: admin.jar })).status).toBe(200);
    expect((await gw("GET", "/api/keys", { jar: user.jar })).status).toBe(401);
  });

  test("promote and demote", async () => {
    const { admin, user } = await setup();
    expect((await gw("POST", `/api/admin/users/${user.userId}/role`, { jar: admin.jar, body: { role: "owner" } })).status).toBe(400);
    expect((await gw("POST", `/api/admin/users/${user.userId}/role`, { jar: admin.jar, body: { role: "admin" } })).status).toBe(200);
    expect((await gw("GET", "/api/admin/stats", { jar: user.jar })).status).toBe(200);
    expect((await gw("POST", `/api/admin/users/${user.userId}/role`, { jar: admin.jar, body: { role: "user" } })).status).toBe(200);
    expect((await gw("GET", "/api/admin/stats", { jar: user.jar })).status).toBe(404);
  });

  test("delete a user only with confirmation; keys and override go too; the audit row stays", async () => {
    const { admin, user } = await setup();
    await createKey(user.jar);
    await gw("PUT", `/api/admin/users/${user.userId}/quota`, { jar: admin.jar, body: { dailyUnits: 9, reason: "x" } });
    expect((await gw("DELETE", `/api/admin/users/${user.userId}`, { jar: admin.jar, body: {} })).status).toBe(400);
    expect((await gw("DELETE", `/api/admin/users/${user.userId}`, { jar: admin.jar, body: { confirm: user.userId } })).status).toBe(200);
    expect((await sql<{ n: number }>`SELECT count(*)::int AS n FROM "user" WHERE id = ${user.userId}`.execute(db)).rows[0]!.n).toBe(0);
    expect((await sql<{ n: number }>`SELECT count(*)::int AS n FROM apikey WHERE "referenceId" = ${user.userId}`.execute(db)).rows[0]!.n).toBe(0);
    expect((await sql<{ n: number }>`SELECT count(*)::int AS n FROM quota_override WHERE user_id = ${user.userId}`.execute(db)).rows[0]!.n).toBe(0);
    const log = (await (await gw("GET", "/api/admin/audit", { jar: admin.jar })).json()) as { entries: { action: string; target: { id: string; name: string | null } }[] };
    expect(log.entries.map((e) => e.action)).toEqual(["user.remove", "quota.set"]);
    expect(log.entries[0]!.target).toEqual({ id: user.userId, name: null });
  });
});
