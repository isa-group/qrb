/**
 * Limit responses and the usage endpoint (task 4.5): `Retry-After` and a
 * `detail` on every 429, quota headers on counted requests (also after a
 * refund), and `GET /api/usage`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "kysely";
import { createApp } from "../src/app";
import { createAuth, type GatewayAuth } from "../src/auth";
import { createTestDatabase, type Database } from "../src/db";
import { migrateUp } from "../src/db/migrator";
import type { LimitsOverrides } from "../src/limits/config";
import { QUOTA_HEADERS } from "../src/limits/quota";
import { acceptCaptcha } from "./helpers/captcha";
import { baseConfig, BEHIND_PROXY, fakeProviders, github, identities, Jar, oauth, ORIGIN, realFetch, unexpected, type App } from "./helpers/providers";

let db: Database;
let auth: GatewayAuth;
let app: App;
let clock: Date;
let status: number;

// 2026-10-28 18:30:00 UTC: 5.5 h = 19800 s to the next 00:00 UTC.
const T0 = new Date("2026-10-28T18:30:00Z");
const MIDNIGHT = Date.UTC(2026, 9, 29) / 1000;

function build(limits: LimitsOverrides = {}) {
  app = createApp({
    ...BEHIND_PROXY,
    captcha: acceptCaptcha,
    auth,
    db,
    limits,
    now: () => clock,
    upstreamUrl: "http://upstream.test:8000",
    secret: "s",
    fetch: async () => Response.json({ ok: true }, { status }),
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
  status = 200;
  clock = new Date(T0);
  db = createTestDatabase();
  await migrateUp(db);
  auth = createAuth(db, baseConfig, { logLevel: "error" });
  build();
});
afterEach(async () => {
  expect(unexpected).toEqual([]);
  await db.destroy();
});

const BODY = { circuit_qasm: "OPENQASM 3.0; qubit[1] q; h q[0];", force_refresh: false };

async function gw(method: string, path: string, opts: { jar?: Jar; headers?: Record<string, string>; body?: unknown; ip?: string } = {}) {
  const headers: Record<string, string> = { origin: ORIGIN, "x-forwarded-for": opts.ip ?? "192.0.2.1", ...opts.headers };
  const cookie = opts.jar?.header();
  if (cookie) headers.cookie = cookie;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await app.request(`${ORIGIN}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  opts.jar?.store(res);
  return res;
}
const resolve = (jar?: Jar, headers: Record<string, string> = {}, ip?: string) => gw("POST", "/api/select", { jar, headers: { "x-captcha-token": "t", ...headers }, body: BODY, ip });
const usage = (jar?: Jar, headers: Record<string, string> = {}) => gw("GET", "/api/usage", { jar, headers });

async function signIn(code = "g1", id = 1): Promise<Jar> {
  github(code, id, `u${id}@example.org`, true);
  const jar = new Jar();
  await oauth(app, jar, "github", code);
  return jar;
}
async function apiKey(jar: Jar): Promise<string> {
  const res = await gw("POST", "/api/keys", { jar, body: { name: "k" } });
  return ((await res.json()) as { key: string }).key;
}
const userCount = async () => (await sql<{ n: number }>`SELECT count(*)::int AS n FROM "user"`.execute(db)).rows[0]!.n;
const unitsUsed = async () => (await sql<{ n: number }>`SELECT coalesce(sum(units_used), 0)::int AS n FROM quota_user_daily`.execute(db)).rows[0]!.n;

async function expectLimit(res: Response, detail: RegExp, retryAfter?: number) {
  expect(res.status).toBe(429);
  expect(((await res.json()) as { detail: string }).detail).toMatch(detail);
  const ra = res.headers.get("retry-after");
  expect(ra).toMatch(/^[1-9][0-9]*$/);
  if (retryAfter !== undefined) expect(Number(ra)).toBe(retryAfter);
}

describe("Quota exhausted", () => {
  test("429 with Retry-After = seconds until 00:00 UTC", async () => {
    build({ dailyUnits: { signed_in: 2 } });
    const jar = await signIn();
    expect((await resolve(jar)).status).toBe(200);
    expect((await resolve(jar)).status).toBe(200);
    await expectLimit(await resolve(jar), /Daily quota exceeded.*signed-in/, 19800);
    clock = new Date("2026-10-28T23:59:30Z");
    await expectLimit(await resolve(jar), /Daily quota/, 30);
    clock = new Date("2026-10-29T00:00:00Z");
    expect((await resolve(jar)).status).toBe(200);
  });
});

describe("Every 429 names its limit and has Retry-After", () => {
  test("user quota (anonymous)", async () => {
    build({ dailyUnits: { anonymous: 1 }, anonymousIpDailyUnits: 100 });
    const jar = new Jar();
    expect((await resolve(jar)).status).toBe(200);
    await expectLimit(await resolve(jar), /Daily quota exceeded.*anonymous/, 19800);
  });

  test("per-IP anonymous cap", async () => {
    build({ anonymousIpDailyUnits: 1 });
    expect((await resolve(new Jar())).status).toBe(200);
    await expectLimit(await resolve(new Jar()), /Per-IP daily cap exceeded/, 19800);
  });

  test("identity burst", async () => {
    build({ burst: { signed_in: 1 } });
    const jar = await signIn();
    expect((await resolve(jar)).status).toBe(200);
    await expectLimit(await resolve(jar), /Burst limit exceeded.*signed-in/);
  });

  test("API key burst", async () => {
    build({ burst: { api_key: 1 } });
    const key = await apiKey(await signIn());
    expect((await resolve(undefined, { "x-api-key": key })).status).toBe(200);
    await expectLimit(await resolve(undefined, { "x-api-key": key }), /Burst limit exceeded.*API key/);
  });

  test("open-route per-IP limit", async () => {
    build({ openRoutePerIp: { limit: 1 } });
    expect((await gw("GET", "/api/health")).status).toBe(200);
    await expectLimit(await gw("GET", "/api/presets"), /Rate limit exceeded.*open routes/);
  });
});

describe("Remaining quota header", () => {
  const h = (res: Response) => ({
    limit: res.headers.get("x-quota-limit"),
    remaining: res.headers.get("x-quota-remaining"),
    reset: res.headers.get("x-quota-reset"),
  });

  test("counted request reports limit, remaining and reset (Unix seconds); decreases per request", async () => {
    build({ dailyUnits: { signed_in: 5 } });
    const jar = await signIn();
    expect(h(await resolve(jar))).toEqual({ limit: "5", remaining: "4", reset: String(MIDNIGHT) });
    expect(h(await resolve(jar)).remaining).toBe("3");
    expect(QUOTA_HEADERS.map((n) => n.toLowerCase())).toEqual(["x-quota-limit", "x-quota-remaining", "x-quota-reset"]);
  });

  test("a live refresh reports the weighted remainder", async () => {
    build({ dailyUnits: { signed_in: 10 }, liveRefreshWeight: 5 });
    const jar = await signIn();
    const res = await gw("POST", "/api/select", { jar, body: { ...BODY, force_refresh: true } });
    expect(h(res).remaining).toBe("5");
  });

  test("after a refunded 5xx the header shows the restored value", async () => {
    build({ dailyUnits: { signed_in: 5 } });
    const jar = await signIn();
    expect(h(await resolve(jar)).remaining).toBe("4");
    status = 503;
    const failed = await resolve(jar);
    expect(failed.status).toBe(503);
    expect(h(failed).remaining).toBe("4");
    expect(await unitsUsed()).toBe(1);
  });

  test("anonymous callers get the smaller of the user's and the IP cap's remainder", async () => {
    build({ dailyUnits: { anonymous: 10 }, anonymousIpDailyUnits: 4 });
    const a = new Jar();
    expect(h(await resolve(a)).remaining).toBe("3");
    const b = new Jar();
    const res = await resolve(b);
    expect(h(res)).toMatchObject({ limit: "10", remaining: "2" });
    status = 502;
    expect(h(await resolve(b)).remaining).toBe("2");
  });

  test("requests that are not counted (open routes, rejections) carry no quota headers", async () => {
    build({ dailyUnits: { signed_in: 0 } });
    const jar = await signIn();
    const rejected = await resolve(jar);
    expect(rejected.status).toBe(429);
    for (const n of QUOTA_HEADERS) expect(rejected.headers.get(n)).toBeNull();
    expect((await gw("GET", "/api/presets")).headers.get("x-quota-remaining")).toBeNull();
  });
});

describe("Usage endpoint", () => {
  test("Check usage: 12 resolves -> 12 used, remaining and reset time", async () => {
    build({ burst: { signed_in: 100 } });
    const jar = await signIn();
    for (let i = 0; i < 12; i++) expect((await resolve(jar)).status).toBe(200);
    const res = await usage(jar);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      tier: "signed_in",
      quota: 200,
      used: 12,
      remaining: 188,
      resetAt: "2026-10-29T00:00:00.000Z",
      secondsUntilReset: 19800,
    });
    expect(await unitsUsed()).toBe(12);
  });

  test("anonymous usage includes the IP cap figures and the effective remainder", async () => {
    build({ dailyUnits: { anonymous: 10 }, anonymousIpDailyUnits: 4 });
    const other = new Jar();
    await resolve(other);
    const jar = new Jar();
    await resolve(jar);
    const body = await (await usage(jar)).json();
    expect(body).toEqual({
      tier: "anonymous",
      quota: 10,
      used: 1,
      remaining: 2,
      resetAt: "2026-10-29T00:00:00.000Z",
      secondsUntilReset: 19800,
      ip: { quota: 4, used: 2, remaining: 2 },
    });
  });

  test("an API key reports its owner's usage (shared with the browser session)", async () => {
    build({ burst: { signed_in: 100 } });
    const jar = await signIn();
    const key = await apiKey(jar);
    await resolve(jar);
    await resolve(undefined, { "x-api-key": key });
    const body = (await (await usage(undefined, { "x-api-key": key })).json()) as { tier: string; used: number };
    expect(body).toMatchObject({ tier: "signed_in", used: 2 });
  });

  test("no identity -> 401, creates no identity, no units; a revoked or unknown key -> 401", async () => {
    const res = await usage();
    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect((await usage(undefined, { "x-captcha-token": "t" })).status).toBe(401);
    expect((await usage(undefined, { "x-api-key": "nope" })).status).toBe(401);
    expect(await userCount()).toBe(0);
    expect(await unitsUsed()).toBe(0);
  });

  test("costs nothing and is subject to the open-route per-IP limit", async () => {
    build({ openRoutePerIp: { limit: 2 } });
    const jar = await signIn();
    expect((await usage(jar)).status).toBe(200);
    expect((await usage(jar)).status).toBe(200);
    await expectLimit(await usage(jar), /Rate limit exceeded.*open routes/);
    expect(await unitsUsed()).toBe(0);
  });
});
