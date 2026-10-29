/**
 * Route policy (task 4.2): open routes, resolve routes need an identity (an
 * anonymous one only for requests carrying a CAPTCHA token), and live refresh
 * needs sign-in (403, never counted).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "kysely";
import { acceptCaptcha } from "./helpers/captcha";
import { createApp } from "../src/app";
import { createAuth } from "../src/auth";
import { createTestDatabase, type Database } from "../src/db";
import { utcDay } from "../src/db/counters";
import { migrateUp } from "../src/db/migrator";
import {
  baseConfig,
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
let app: App;
const upstream: Request[] = [];

beforeAll(() => {
  globalThis.fetch = fakeProviders as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});
beforeEach(async () => {
  identities.clear();
  unexpected.length = 0;
  upstream.length = 0;
  db = createTestDatabase();
  await migrateUp(db);
  app = createApp({
    ...BEHIND_PROXY,
    captcha: acceptCaptcha,
    auth: createAuth(db, baseConfig, { logLevel: "error" }),
    db,
    upstreamUrl: "http://upstream.test:8000",
    secret: "s",
    fetch: async (r) => (upstream.push(r), Response.json({ ok: true })),
  });
});
afterEach(async () => {
  expect(unexpected).toEqual([]);
  await db.destroy();
});

const QASM = "OPENQASM 3.0; qubit[2] q; h q[0]; cx q[0], q[1];";
const CAPTCHA = { "x-captcha-token": "tok" };

async function gw(method: string, path: string, opts: { jar?: Jar; headers?: Record<string, string>; body?: unknown } = {}) {
  const headers: Record<string, string> = { origin: ORIGIN, "x-forwarded-for": "192.0.2.1", ...opts.headers };
  const cookie = opts.jar?.header();
  if (cookie) headers.cookie = cookie;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await app.request(`${ORIGIN}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  opts.jar?.store(res);
  return res;
}

const userCount = async () => (await sql<{ n: number }>`SELECT count(*)::int AS n FROM "user"`.execute(db)).rows[0]!.n;
const totalUnits = async () =>
  (await sql<{ n: number }>`SELECT coalesce(sum(units_used), 0)::int AS n FROM quota_user_daily`.execute(db)).rows[0]!.n;
const unitsToday = async (id: string) =>
  (await sql<{ u: number }>`SELECT units_used AS u FROM quota_user_daily WHERE user_id = ${id} AND day = ${utcDay()}::date`.execute(db)).rows[0]
    ?.u ?? 0;

async function signIn(): Promise<{ jar: Jar; userId: string }> {
  github("g1", 1, "u1@example.org", true);
  const jar = new Jar();
  await oauth(app, jar, "github", "g1");
  return { jar, userId: await signedInUserId(app, jar) };
}

describe("Open routes", () => {
  test("callable without cookie or key, forwarded, no identity created", async () => {
    for (const path of ["/api/catalog", "/api/catalog/abc", "/api/presets", "/api/engines", "/api/catalog?force_refresh=false"]) {
      const res = await gw("GET", path);
      expect([path, res.status]).toEqual([path, 200]);
      expect(res.headers.getSetCookie()).toEqual([]);
    }
    expect(upstream).toHaveLength(5);
    expect((await gw("GET", "/api/health")).status).toBe(200);
    expect(await userCount()).toBe(0);
    expect(await totalUnits()).toBe(0);
  });
});

describe("Resolve routes need an identity", () => {
  for (const path of ["/api/select", "/api/instance"]) {
    test(`${path}: script with no cookie, key or CAPTCHA token -> 401, nothing created, not forwarded`, async () => {
      for (const body of [{ circuit_qasm: QASM, force_refresh: false }, { circuit_qasm: QASM, force_refresh: true }, { circuit_qasm: QASM }]) {
        const res = await gw("POST", path, { body });
        expect(res.status).toBe(401);
        expect(res.headers.getSetCookie()).toEqual([]);
      }
      expect((await gw("POST", path, { headers: { "x-captcha-token": "  " }, body: { force_refresh: false } })).status).toBe(401);
      expect(upstream).toHaveLength(0);
      expect(await userCount()).toBe(0);
      expect(await totalUnits()).toBe(0);
    });
  }

  test("first browser-style resolve (CAPTCHA token) gets an anonymous identity, 1 unit, session cookie; the token is not forwarded", async () => {
    const jar = new Jar();
    const res = await gw("POST", "/api/select", { jar, headers: CAPTCHA, body: { circuit_qasm: QASM, force_refresh: false } });
    expect(res.status).toBe(200);
    expect(jar.cookies.has("better-auth.session_token")).toBe(true);
    expect(await userCount()).toBe(1);
    expect(upstream[0]!.headers.get("x-captcha-token")).toBeNull();
    expect(await totalUnits()).toBe(1);
    // Later anonymous requests ride on the cookie but still need a token (task 4.4).
    expect((await gw("POST", "/api/select", { jar, headers: CAPTCHA, body: { force_refresh: false } })).status).toBe(200);
    expect(await userCount()).toBe(1);
  });

  test("a signed-in session needs no CAPTCHA token", async () => {
    const { jar } = await signIn();
    expect((await gw("POST", "/api/select", { jar, body: { force_refresh: false } })).status).toBe(200);
  });
});

describe("Anonymous users get the cached catalog only", () => {
  const anonBody = (extra: object) => ({ circuit_qasm: QASM, ...extra });

  test("force_refresh true or omitted -> 403, no units, no identity created, not forwarded", async () => {
    for (const path of ["/api/select", "/api/instance"]) {
      for (const body of [anonBody({ force_refresh: true }), anonBody({}), anonBody({ force_refresh: "false" })]) {
        const res = await gw("POST", path, { headers: CAPTCHA, body });
        expect(res.status).toBe(403);
        expect(((await res.json()) as { detail: string }).detail).toContain("sign-in");
        expect(res.headers.getSetCookie()).toEqual([]);
      }
    }
    expect(upstream).toHaveLength(0);
    expect(await totalUnits()).toBe(0);
    expect(await userCount()).toBe(0);
  });

  test("an existing anonymous session is also refused live refresh and not charged", async () => {
    const jar = new Jar();
    expect((await gw("POST", "/api/select", { jar, headers: CAPTCHA, body: anonBody({ force_refresh: false }) })).status).toBe(200);
    expect((await gw("POST", "/api/select", { jar, body: anonBody({ force_refresh: true }) })).status).toBe(403);
    expect((await gw("POST", "/api/select", { jar, body: anonBody({}) })).status).toBe(403);
    expect(await totalUnits()).toBe(1);
    expect(upstream).toHaveLength(1);
  });

  test("force_refresh false -> forwarded, 1 unit", async () => {
    const res = await gw("POST", "/api/instance", { headers: CAPTCHA, body: anonBody({ force_refresh: false }) });
    expect(res.status).toBe(200);
    expect(upstream).toHaveLength(1);
    expect(await totalUnits()).toBe(1);
  });

  test("catalog with force_refresh=true: no identity -> 403; anonymous -> 403; neither is counted or forwarded", async () => {
    for (const path of ["/api/catalog?force_refresh=true", "/api/catalog/abc?force_refresh=1"]) {
      const res = await gw("GET", path);
      expect([path, res.status]).toEqual([path, 403]);
    }
    const jar = new Jar();
    await gw("POST", "/api/select", { jar, headers: CAPTCHA, body: anonBody({ force_refresh: false }) });
    upstream.length = 0;
    expect((await gw("GET", "/api/catalog?force_refresh=true", { jar })).status).toBe(403);
    expect(upstream).toHaveLength(0);
    expect(await totalUnits()).toBe(1);
  });

  test("signed-in users are unaffected: force_refresh true costs 5 and is forwarded; catalog live refresh too", async () => {
    const { jar, userId } = await signIn();
    expect((await gw("POST", "/api/select", { jar, body: anonBody({ force_refresh: true }) })).status).toBe(200);
    expect(await unitsToday(userId)).toBe(5);
    expect((await gw("POST", "/api/select", { jar, body: anonBody({}) })).status).toBe(200);
    expect(await unitsToday(userId)).toBe(10);
    expect((await gw("GET", "/api/catalog?force_refresh=true", { jar })).status).toBe(200);
    expect(await unitsToday(userId)).toBe(15);
  });
});
