/**
 * Quota engine (task 4.1): daily units per user and UTC day, live-refresh
 * weight, keys sharing the owner's quota, refunds on 5xx, nothing charged for
 * requests rejected before forwarding, and concurrent requests at the limit.
 *
 * About the parallel tests: PGlite has ONE connection, so concurrent requests
 * reach the database one statement at a time. They prove the middleware has
 * no check-then-act race in JS (no read of the counter followed by a separate
 * write across an `await`): the decision is the single conditional upsert.
 * They do not exercise Postgres row locking across connections; that relies
 * on `INSERT ... ON CONFLICT DO UPDATE ... WHERE` semantics (see
 * `src/db/counters.ts`), which PGlite and Postgres share.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "kysely";
import { acceptCaptcha } from "./helpers/captcha";
import { createApp } from "../src/app";
import { createAuth, type GatewayAuth } from "../src/auth";
import { createTestDatabase, type Database } from "../src/db";
import { refundDailyUnits, tryConsumeDailyUnits, utcDay } from "../src/db/counters";
import { migrateUp } from "../src/db/migrator";
import { DEFAULT_LIMITS, limitsConfig, type LimitsOverrides } from "../src/limits/config";
import { consumeQuota, secondsUntilReset } from "../src/limits/quota";
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
let auth: GatewayAuth;
let app: App;
let clock: Date;
let upstreamCalls: number;
let respond: (req: Request) => Promise<Response>;

const okUpstream = async () => Response.json({ ok: true });

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
    fetch: async (r) => {
      upstreamCalls++;
      return respond(r);
    },
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
  upstreamCalls = 0;
  respond = okUpstream;
  clock = new Date("2026-10-28T12:00:00Z");
  db = createTestDatabase();
  await migrateUp(db);
  auth = createAuth(db, baseConfig, { logLevel: "error" });
  build();
});
afterEach(async () => {
  expect(unexpected).toEqual([]);
  await db.destroy();
});

const QASM = "OPENQASM 3.0; qubit[2] q; h q[0]; cx q[0], q[1];";
const CACHED = { circuit_qasm: QASM, force_refresh: false };
const LIVE = { circuit_qasm: QASM, force_refresh: true };
const DEFAULT = { circuit_qasm: QASM };

async function gw(method: string, path: string, opts: { jar?: Jar; headers?: Record<string, string>; body?: unknown } = {}): Promise<Response> {
  const headers: Record<string, string> = { origin: ORIGIN, "x-forwarded-for": "192.0.2.1", "x-captcha-token": "t", ...opts.headers };
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

async function signIn(code = "g1", id = 1): Promise<{ jar: Jar; userId: string }> {
  github(code, id, `u${id}@example.org`, true);
  const jar = new Jar();
  await oauth(app, jar, "github", code);
  return { jar, userId: await signedInUserId(app, jar) };
}

async function createKey(jar: Jar): Promise<string> {
  const res = await gw("POST", "/api/keys", { jar, body: { name: "ci" } });
  expect(res.status).toBe(201);
  return ((await res.json()) as { key: string }).key;
}

const unitsOn = async (userId: string, day: string) =>
  (
    await sql<{ units_used: number }>`
      SELECT units_used FROM quota_user_daily WHERE user_id = ${userId} AND day = ${day}::date`.execute(db)
  ).rows[0]?.units_used ?? 0;
const unitsToday = (userId: string) => unitsOn(userId, utcDay(clock));
const rowCount = async () => (await sql<{ n: number }>`SELECT count(*)::int AS n FROM quota_user_daily`.execute(db)).rows[0]!.n;
const resolve = (jar: Jar | undefined, body: unknown, path = "/api/select", headers?: Record<string, string>) =>
  gw("POST", path, { jar, body, headers });

describe("Daily resolve quota", () => {
  test("defaults match the design: anonymous 10, signed in 200, live refresh 5", () => {
    expect(limitsConfig()).toMatchObject({ dailyUnits: { anonymous: 10, signed_in: 200 }, liveRefreshWeight: 5 });
    expect(DEFAULT_LIMITS.dailyUnits.signed_in).toBe(200);
    expect(() => limitsConfig({ liveRefreshWeight: 0 })).toThrow(RangeError);
    expect(() => limitsConfig({ dailyUnits: { anonymous: -1 } })).toThrow(RangeError);
  });

  test("Keys share the owner's quota: 15 units in the browser, then the 6th key request of a 20-unit quota is rejected", async () => {
    build({ dailyUnits: { signed_in: 20 } });
    const { jar, userId } = await signIn();
    const key = await createKey(jar);

    for (let i = 0; i < 15; i++) expect((await resolve(jar, CACHED)).status).toBe(200);
    for (let i = 0; i < 5; i++) expect((await resolve(undefined, CACHED, "/api/instance", { "x-api-key": key })).status).toBe(200);
    expect(await unitsToday(userId)).toBe(20);

    const calls = upstreamCalls;
    const rejected = await resolve(undefined, CACHED, "/api/select", { "x-api-key": key });
    expect(rejected.status).toBe(429);
    const body = (await rejected.json()) as { detail: string };
    expect(body.detail).toContain("Daily quota exceeded");
    expect(body.detail).toContain("20 units per day");
    expect(rejected.headers.get("retry-after")).toBe(String(12 * 3600));
    expect(upstreamCalls).toBe(calls); // not forwarded
    expect(await unitsToday(userId)).toBe(20); // rejection writes nothing

    // The browser session is out of units too: one budget.
    expect((await resolve(jar, CACHED)).status).toBe(429);
  });

  test("Anonymous identity gets the anonymous quota (10 per day)", async () => {
    build({ burst: { anonymous: 100 } }); // fixed clock: keep the 3/min burst out of the way
    const jar = new Jar();
    for (let i = 0; i < 10; i++) expect((await resolve(jar, CACHED)).status).toBe(200);
    const res = await resolve(jar, CACHED);
    expect(res.status).toBe(429);
    expect(((await res.json()) as { detail: string }).detail).toContain("anonymous users get 10 units");
    expect(upstreamCalls).toBe(10);
    const { rows } = await sql<{ user_id: string; units_used: number }>`SELECT user_id, units_used FROM quota_user_daily`.execute(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.units_used).toBe(10);
  });

  test("UTC day rollover: yesterday's units do not count today", async () => {
    build({ dailyUnits: { signed_in: 3 } });
    const { jar, userId } = await signIn();
    clock = new Date("2026-10-28T23:59:58Z");
    for (let i = 0; i < 3; i++) expect((await resolve(jar, CACHED)).status).toBe(200);
    clock = new Date("2026-10-28T23:59:59.250Z");
    const rejected = await resolve(jar, CACHED);
    expect(rejected.status).toBe(429);
    expect(rejected.headers.get("retry-after")).toBe("1");

    clock = new Date("2026-10-29T00:00:00Z");
    expect((await resolve(jar, CACHED)).status).toBe(200);
    expect(await unitsOn(userId, "2026-10-28")).toBe(3);
    expect(await unitsOn(userId, "2026-10-29")).toBe(1);
  });

  test("Retry-After is the seconds until 00:00 UTC", () => {
    expect(secondsUntilReset(new Date("2026-10-28T00:00:00Z"))).toBe(86400);
    expect(secondsUntilReset(new Date("2026-10-28T23:00:00.001Z"))).toBe(3600);
    expect(secondsUntilReset(new Date("2026-12-31T23:59:59.999Z"))).toBe(1);
  });

  test("consumeQuota returns used, remaining and reset time (for the 4.5 headers and usage endpoint)", async () => {
    const cfg = limitsConfig({ dailyUnits: { signed_in: 12 } });
    const r = await consumeQuota(db, cfg, { userId: "u", tier: "signed_in", cost: 5, now: clock });
    expect(r).toEqual({
      ok: true,
      reservation: {
        userId: "u",
        tier: "signed_in",
        quota: 12,
        cost: 5,
        day: "2026-10-28",
        used: 5,
        remaining: 7,
        resetAt: new Date("2026-10-29T00:00:00Z"),
        refunded: false,
      },
    });
    await consumeQuota(db, cfg, { userId: "u", tier: "signed_in", cost: 5, now: clock });
    const no = await consumeQuota(db, cfg, { userId: "u", tier: "signed_in", cost: 5, now: clock });
    expect(no).toMatchObject({ ok: false, tier: "signed_in", quota: 12, cost: 5 });
  });
});

describe("Live refresh costs more", () => {
  test("Live refresh weight of 5: resolve costs follow the effective force_refresh", async () => {
    const { jar, userId } = await signIn();
    const cases: [string, unknown, number][] = [
      ["/api/select", LIVE, 5],
      ["/api/select", DEFAULT, 5], // Python default is true on /select
      ["/api/instance", DEFAULT, 5], // ... and on /instance
      ["/api/select", CACHED, 1],
      ["/api/instance", CACHED, 1],
      ["/api/instance", LIVE, 5],
      // Non-boolean: the effective value is the default (never undercharges).
      ["/api/select", { circuit_qasm: QASM, force_refresh: "false" }, 5],
      ["/api/select", { circuit_qasm: QASM, force_refresh: null }, 5],
    ];
    let expected = 0;
    for (const [path, body, cost] of cases) {
      expect((await resolve(jar, body, path)).status).toBe(200);
      expected += cost;
      expect([path, body, await unitsToday(userId)]).toEqual([path, body, expected]);
    }
  });

  test("catalog reads are free unless force_refresh=true, which costs the weight", async () => {
    const { jar, userId } = await signIn();
    for (const path of ["/api/catalog", "/api/catalog/abc", "/api/catalog?force_refresh=false", "/api/catalog/abc?force_refresh=0", "/api/engines", "/api/presets"]) {
      expect([path, (await gw("GET", path, { jar })).status]).toEqual([path, 200]);
    }
    expect(await rowCount()).toBe(0);

    expect((await gw("GET", "/api/catalog?force_refresh=true", { jar })).status).toBe(200);
    expect(await unitsToday(userId)).toBe(5);
    expect((await gw("GET", "/api/catalog/abc?force_refresh=True", { jar })).status).toBe(200);
    expect(await unitsToday(userId)).toBe(10);
  });

  test("the weight is configurable", async () => {
    build({ liveRefreshWeight: 3 });
    const { jar, userId } = await signIn();
    await resolve(jar, LIVE);
    await gw("GET", "/api/catalog?force_refresh=true", { jar });
    expect(await unitsToday(userId)).toBe(6);
  });

  test("a live refresh that does not fit the remaining units is rejected, a cached one still fits", async () => {
    build({ dailyUnits: { signed_in: 7 } });
    const { jar, userId } = await signIn();
    expect((await resolve(jar, LIVE)).status).toBe(200);
    expect((await resolve(jar, LIVE)).status).toBe(429);
    expect((await resolve(jar, CACHED)).status).toBe(200);
    expect(await unitsToday(userId)).toBe(6);
  });
});

describe("Failed requests are not charged", () => {
  test("Solver down: upstream 5xx refunds the units", async () => {
    const { jar, userId } = await signIn();
    for (const status of [500, 502, 503, 504]) {
      respond = async () => Response.json({ detail: "OpenBinding unreachable" }, { status });
      const res = await resolve(jar, LIVE);
      expect(res.status).toBe(status);
      expect(await unitsToday(userId)).toBe(0);
    }
    respond = async () => Response.json({ detail: "catalog fetch failed" }, { status: 502 });
    expect((await gw("GET", "/api/catalog?force_refresh=true", { jar })).status).toBe(502);
    expect(await unitsToday(userId)).toBe(0);
  });

  test("upstream unreachable (fetch throws, gateway answers 502): no units deducted", async () => {
    const { jar, userId } = await signIn();
    respond = async () => {
      throw new TypeError("connection refused");
    };
    const res = await resolve(jar, CACHED);
    expect(res.status).toBe(502);
    expect(await unitsToday(userId)).toBe(0);
  });

  test("a refund never takes back units from other requests, and the quota is usable again", async () => {
    build({ dailyUnits: { signed_in: 5 } });
    const { jar, userId } = await signIn();
    for (let i = 0; i < 4; i++) await resolve(jar, CACHED);
    respond = async () => new Response("down", { status: 503 });
    await resolve(jar, CACHED);
    expect(await unitsToday(userId)).toBe(4);
    respond = okUpstream;
    expect((await resolve(jar, CACHED)).status).toBe(200);
    expect((await resolve(jar, CACHED)).status).toBe(429);
  });

  test("a 4xx from the upstream (after forwarding) is charged", async () => {
    const { jar, userId } = await signIn();
    respond = async () => Response.json({ detail: [{ msg: "invalid QASM" }] }, { status: 422 });
    const res = await resolve(jar, CACHED);
    expect(res.status).toBe(422);
    expect(await unitsToday(userId)).toBe(1);
  });

  test("requests rejected before forwarding consume nothing", async () => {
    const { jar, userId } = await signIn();
    // snapshot_path -> 422 in the gateway.
    const snap = await resolve(jar, { ...LIVE, snapshot_path: "/etc/passwd" });
    expect(snap.status).toBe(422);
    // Bad key -> 401, even with a valid session cookie.
    const bad = await resolve(jar, LIVE, "/api/select", { "x-api-key": "qrb_nope" });
    expect(bad.status).toBe(401);
    const badCatalog = await gw("GET", "/api/catalog?force_refresh=true", { jar, headers: { "x-api-key": "qrb_nope" } });
    expect(badCatalog.status).toBe(401);
    // Oversized body -> 413.
    const big = await resolve(jar, { ...CACHED, pad: "x".repeat(1024 * 1024 + 1) });
    expect(big.status).toBe(413);

    expect(upstreamCalls).toBe(0);
    expect(await unitsToday(userId)).toBe(0);
    expect(await rowCount()).toBe(0);
  });

  test("refundDailyUnits is clamped at zero and a no-op without a row", async () => {
    const day = utcDay(clock);
    expect(await refundDailyUnits(db, { table: "quota_user_daily", key: "u", day, units: 3 })).toBeNull();
    await tryConsumeDailyUnits(db, { table: "quota_user_daily", key: "u", day, units: 2, quota: 10 });
    expect(await refundDailyUnits(db, { table: "quota_user_daily", key: "u", day, units: 5 })).toBe(0);
  });
});

describe("Concurrency at the limit", () => {
  // Slow upstream, so all requests are reserved before any finishes.
  const slow = async () => {
    await Bun.sleep(30);
    return Response.json({ ok: true });
  };

  test("N concurrent live resolves against 13 remaining units accept exactly floor(13 / 5) = 2", async () => {
    build({ dailyUnits: { signed_in: 20 } });
    const { jar, userId } = await signIn();
    await tryConsumeDailyUnits(db, { table: "quota_user_daily", key: userId, day: utcDay(clock), units: 7, quota: 20 });
    respond = slow;
    const results = await Promise.all(Array.from({ length: 8 }, () => resolve(jar, LIVE)));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 200)).toHaveLength(2);
    expect(statuses.filter((s) => s === 429)).toHaveLength(6);
    expect(upstreamCalls).toBe(2);
    expect(await unitsToday(userId)).toBe(17);
  });

  test("N concurrent cached resolves through session and key against 4 remaining units accept exactly 4", async () => {
    build({ dailyUnits: { signed_in: 10 } });
    const { jar, userId } = await signIn();
    const key = await createKey(jar);
    await tryConsumeDailyUnits(db, { table: "quota_user_daily", key: userId, day: utcDay(clock), units: 6, quota: 10 });
    respond = slow;
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => (i % 2 ? resolve(jar, CACHED) : resolve(undefined, CACHED, "/api/instance", { "x-api-key": key }))),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(4);
    expect(results.filter((r) => r.status === 429)).toHaveLength(8);
    expect(await unitsToday(userId)).toBe(10);
  });

  test("concurrent failures refund exactly what they took", async () => {
    build({ dailyUnits: { signed_in: 10 } });
    const { jar, userId } = await signIn();
    let n = 0;
    respond = async () => {
      await Bun.sleep(10);
      return n++ % 2 ? Response.json({ ok: true }) : new Response("down", { status: 503 });
    };
    const results = await Promise.all(Array.from({ length: 6 }, () => resolve(jar, CACHED)));
    const ok = results.filter((r) => r.status === 200).length;
    expect(ok).toBe(3);
    expect(await unitsToday(userId)).toBe(ok);
  });
});
