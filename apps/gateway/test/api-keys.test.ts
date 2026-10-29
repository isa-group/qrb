/**
 * API keys: create (secret shown once), list, revoke; authentication through
 * `x-api-key` on the forwarded routes; no anonymous identity for key requests.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "kysely";
import { acceptCaptcha } from "./helpers/captcha";
import { createApp } from "../src/app";
import { createAuth, type GatewayAuth } from "../src/auth";
import { createTestDatabase, type Database } from "../src/db";
import { migrateUp } from "../src/db/migrator";
import {
  baseConfig,
  call,
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
  BEHIND_PROXY,
} from "./helpers/providers";

let db: Database;
let auth: GatewayAuth;
let app: App;
const upstreamSeen: Request[] = [];

beforeAll(() => {
  globalThis.fetch = fakeProviders as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});
beforeEach(async () => {
  identities.clear();
  unexpected.length = 0;
  upstreamSeen.length = 0;
  db = createTestDatabase();
  await migrateUp(db);
  auth = createAuth(db, baseConfig, { logLevel: "error" });
  app = createApp({
    ...BEHIND_PROXY,
    captcha: acceptCaptcha,
    // The per-key burst (20/min) is covered by ip-and-burst.test.ts; here it
    // would cut off the 25-request test of the plugin's own limiter.
    limits: { burst: { api_key: 1000 } },
    auth,
    upstreamUrl: "http://upstream.test:8000",
    secret: "s",
    fetch: async (r) => (upstreamSeen.push(r), Response.json({ ok: true })),
  });
});
afterEach(async () => {
  expect(unexpected).toEqual([]);
  await db.destroy();
});

const SELECT_BODY = { circuit_qasm: "OPENQASM 3.0; qubit[2] q; h q[0]; cx q[0], q[1];", force_refresh: false };

function gw(method: string, path: string, opts: { jar?: Jar; headers?: Record<string, string>; body?: unknown } = {}) {
  const headers: Record<string, string> = { origin: ORIGIN, "x-forwarded-for": "192.0.2.1", ...opts.headers };
  const cookie = opts.jar?.header();
  if (cookie) headers.cookie = cookie;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  return app.request(`${ORIGIN}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
}

async function signIn(code: string, id: number): Promise<{ jar: Jar; userId: string }> {
  github(code, id, `u${id}@example.org`, true);
  const jar = new Jar();
  await oauth(app, jar, "github", code);
  return { jar, userId: await signedInUserId(app, jar) };
}

type Created = { id: string; name: string; key: string; start: string; prefix: string; createdAt: string };
async function createKey(jar: Jar, name = "ci"): Promise<Created> {
  const res = await gw("POST", "/api/keys", { jar, body: { name } });
  expect(res.status).toBe(201);
  return (await res.json()) as Created;
}

const userCount = async () => (await sql<{ n: number }>`SELECT count(*)::int AS n FROM "user"`.execute(db)).rows[0]!.n;
const lastUpstreamUser = () => upstreamSeen.at(-1)!.headers.get("x-qrb-user-id");

describe("API keys", () => {
  test("create a key: secret returned once; listing shows name, prefix and creation time only", async () => {
    const { jar } = await signIn("g1", 1);
    const created = await createKey(jar, "my script");
    expect(created.key).toMatch(/^qrb_[A-Za-z]{64}$/);
    expect(created.name).toBe("my script");
    expect(created.start).toBe(created.key.slice(0, 6));

    const list = await gw("GET", "/api/keys", { jar });
    expect(list.status).toBe(200);
    const text = await list.text();
    expect(text).not.toContain(created.key);
    const body = JSON.parse(text) as { keys: Record<string, unknown>[] };
    expect(body.keys).toHaveLength(1);
    expect(Object.keys(body.keys[0]!).sort()).toEqual(["createdAt", "id", "name", "prefix", "start"]);
    expect(body.keys[0]).toMatchObject({ id: created.id, name: "my script", prefix: "qrb_", start: created.start });
    expect(Number.isNaN(Date.parse(body.keys[0]!.createdAt as string))).toBe(false);

    // Stored hashed: the secret is nowhere in the table.
    const rows = (await sql<{ key: string }>`SELECT key FROM "apikey"`.execute(db)).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.key).not.toBe(created.key);
    expect(rows[0]!.key).not.toContain(created.key);
  });

  test("each user lists and revokes only their own keys", async () => {
    const a = await signIn("g1", 1);
    const b = await signIn("g2", 2);
    const keyA = await createKey(a.jar);
    expect(((await (await gw("GET", "/api/keys", { jar: b.jar })).json()) as { keys: unknown[] }).keys).toEqual([]);
    const res = await gw("DELETE", `/api/keys/${keyA.id}`, { jar: b.jar });
    expect(res.status).toBe(404);
    const ok = await gw("POST", "/api/select", { headers: { "x-api-key": keyA.key }, body: SELECT_BODY });
    expect(ok.status).toBe(200);
  });

  test("create needs a name", async () => {
    const { jar } = await signIn("g1", 1);
    for (const body of [{}, { name: "" }, { name: "x".repeat(33) }, { name: 5 }]) {
      expect((await gw("POST", "/api/keys", { jar, body })).status).toBe(400);
    }
  });

  test("anonymous sessions and callers without a session cannot manage keys", async () => {
    const anon = new Jar();
    anon.store(await gw("POST", "/api/select", { headers: { "x-captcha-token": "t" }, body: SELECT_BODY })); // gets an anonymous identity
    expect(anon.cookies.size).toBeGreaterThan(0);

    expect((await gw("POST", "/api/keys", { jar: anon, body: { name: "x" } })).status).toBe(403);
    expect((await gw("GET", "/api/keys", { jar: anon })).status).toBe(403);
    expect((await gw("POST", "/api/keys", { body: { name: "x" } })).status).toBe(401);
    expect((await sql`SELECT 1 FROM "apikey"`.execute(db)).rows).toHaveLength(0);

    // The plugin's own routes are not reachable either.
    const direct = await call(app, anon, "POST", "/api-key/create", { name: "x" });
    expect(direct.status).toBe(404);
    expect((await sql`SELECT 1 FROM "apikey"`.execute(db)).rows).toHaveLength(0);
  });

  test("a key cannot manage keys", async () => {
    const { jar } = await signIn("g1", 1);
    const k = await createKey(jar);
    expect((await gw("POST", "/api/keys", { headers: { "x-api-key": k.key }, body: { name: "x" } })).status).toBe(401);
    expect((await gw("GET", "/api/keys", { jar, headers: { "x-api-key": k.key } })).status).toBe(401);
  });

  test("a valid key on POST /api/select forwards as the owner and creates no anonymous user", async () => {
    const { jar, userId } = await signIn("g1", 1);
    const k = await createKey(jar);
    const before = await userCount();

    const res = await gw("POST", "/api/select", { headers: { "x-api-key": k.key }, body: SELECT_BODY });
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(lastUpstreamUser()).toBe(userId);
    expect(upstreamSeen.at(-1)!.headers.get("x-api-key")).toBeNull(); // secret not passed on
    expect(await userCount()).toBe(before);

    for (const path of ["/api/catalog", "/api/engines", "/api/presets"]) {
      const g = await gw("GET", path, { headers: { "x-api-key": k.key } });
      expect([path, g.status]).toEqual([path, 200]);
      expect(lastUpstreamUser()).toBe(userId);
    }
  });

  test("revoked key: 401, upstream not called; unknown, empty and malformed keys: 401", async () => {
    const { jar } = await signIn("g1", 1);
    const k = await createKey(jar);
    expect((await gw("POST", "/api/select", { headers: { "x-api-key": k.key }, body: SELECT_BODY })).status).toBe(200);
    upstreamSeen.length = 0;

    const del = await gw("DELETE", `/api/keys/${k.id}`, { jar });
    expect(del.status).toBe(200);
    expect(((await (await gw("GET", "/api/keys", { jar })).json()) as { keys: unknown[] }).keys).toEqual([]);

    for (const key of [k.key, "qrb_" + "a".repeat(64), "", "nope", "x".repeat(5000)]) {
      const res = await gw("POST", "/api/select", { headers: { "x-api-key": key }, body: SELECT_BODY });
      expect([key.slice(0, 8), res.status]).toEqual([key.slice(0, 8), 401]);
      expect(typeof ((await res.json()) as { detail: unknown }).detail).toBe("string");
      expect(res.headers.getSetCookie()).toEqual([]);
    }
    expect((await gw("GET", "/api/catalog", { headers: { "x-api-key": k.key } })).status).toBe(401);
    expect(upstreamSeen).toEqual([]);
    expect(await userCount()).toBe(1);
    expect((await gw("DELETE", `/api/keys/${k.id}`, { jar })).status).toBe(404);
  });

  test("expired key: 401", async () => {
    const { jar } = await signIn("g1", 1);
    const k = await createKey(jar);
    await sql`UPDATE "apikey" SET "expiresAt" = now() - interval '1 hour'`.execute(db);
    const res = await gw("POST", "/api/select", { headers: { "x-api-key": k.key }, body: SELECT_BODY });
    expect(res.status).toBe(401);
    expect(upstreamSeen).toEqual([]);
  });

  test("the plugin's default limiter (10 per 24 h) and per-key remaining do not apply", async () => {
    const { jar } = await signIn("g1", 1);
    const k = await createKey(jar);
    for (let i = 0; i < 25; i++) {
      const res = await gw("POST", "/api/select", { headers: { "x-api-key": k.key }, body: SELECT_BODY });
      expect([i, res.status]).toEqual([i, 200]);
    }
    expect(upstreamSeen).toHaveLength(25);
    const row = (await sql<{ rateLimitEnabled: boolean; remaining: number | null }>`SELECT "rateLimitEnabled", remaining FROM "apikey"`.execute(db)).rows[0]!;
    expect(row).toEqual({ rateLimitEnabled: false, remaining: null });
  });

  test("a key beats a session cookie; an invalid key is refused even with a valid cookie", async () => {
    const owner = await signIn("g1", 1);
    const other = await signIn("g2", 2);
    const k = await createKey(owner.jar);

    const res = await gw("POST", "/api/select", { jar: other.jar, headers: { "x-api-key": k.key }, body: SELECT_BODY });
    expect(res.status).toBe(200);
    expect(lastUpstreamUser()).toBe(owner.userId);

    upstreamSeen.length = 0;
    const bad = await gw("POST", "/api/select", { jar: other.jar, headers: { "x-api-key": "qrb_bad" }, body: SELECT_BODY });
    expect(bad.status).toBe(401);
    expect(upstreamSeen).toEqual([]);
  });

  test("the plugin does not turn a key into a Better Auth session", async () => {
    const { jar } = await signIn("g1", 1);
    const k = await createKey(jar);
    const res = await app.request(`${ORIGIN}/api/auth/get-session`, { headers: { "x-api-key": k.key } });
    expect(await res.json()).toBeNull();
  });

  test("deleting a user deletes their keys", async () => {
    const a = await signIn("g1", 1);
    const b = await signIn("g2", 2);
    const ka = await createKey(a.jar);
    const kb = await createKey(b.jar);
    const ctx = await auth.$context;
    await ctx.internalAdapter.deleteUser(a.userId);

    const rows = (await sql<{ id: string }>`SELECT id FROM "apikey"`.execute(db)).rows;
    expect(rows.map((r) => r.id)).toEqual([kb.id]);
    expect((await gw("POST", "/api/select", { headers: { "x-api-key": ka.key }, body: SELECT_BODY })).status).toBe(401);
    expect((await gw("POST", "/api/select", { headers: { "x-api-key": kb.key }, body: SELECT_BODY })).status).toBe(200);
  });
});
