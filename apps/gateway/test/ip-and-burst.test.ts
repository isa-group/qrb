/**
 * Task 4.3: client IP resolution (TRUSTED_PROXIES), the per-IP cap shared by
 * all anonymous identities, sliding-window burst limits per identity and per
 * API key, and the per-IP limit on open routes.
 *
 * Every test gets a fresh PGlite database, an injected clock (`clock`) and an
 * injected socket address (`peer`, what Bun's `server.requestIP` would report).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "kysely";
import { acceptCaptcha } from "./helpers/captcha";
import { createApp } from "../src/app";
import { createAuth, type GatewayAuth } from "../src/auth";
import { CLIENT_IP_HEADER, clientKey, resolveClientIp, TrustedProxies, trustedProxiesFromEnv, UNKNOWN_CLIENT } from "../src/client-ip";
import { createTestDatabase, type Database } from "../src/db";
import { migrateUp } from "../src/db/migrator";
import { burstRetryAfterMs } from "../src/limits/burst";
import { DEFAULT_LIMITS, limitsConfig, type LimitsOverrides } from "../src/limits/config";
import { secondsUntilReset } from "../src/limits/quota";
import { baseConfig, fakeProviders, github, identities, Jar, oauth, ORIGIN, realFetch, signedInUserId, unexpected, type App } from "./helpers/providers";

let db: Database;
let auth: GatewayAuth;
let app: App;
let clock: Date;
let peer: string | undefined;
let upstream: Request[];
let respond: (req: Request) => Promise<Response>;

const T0 = new Date("2026-10-28T12:00:00Z"); // a multiple of 60 s: window boundaries fall on whole minutes

function build(limits: LimitsOverrides = {}, trustedProxies?: string[]) {
  app = createApp({
    captcha: acceptCaptcha,
    auth,
    db,
    limits,
    trustedProxies,
    now: () => clock,
    clientAddress: () => peer,
    upstreamUrl: "http://upstream.test:8000",
    secret: "s",
    fetch: async (r) => {
      upstream.push(r);
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
  upstream = [];
  respond = async () => Response.json({ ok: true });
  clock = new Date(T0);
  peer = "127.0.0.1"; // the local reverse proxy
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

interface Opts {
  jar?: Jar;
  /** X-Forwarded-For; `null` sends none. Default 192.0.2.1. */
  xff?: string | null;
  headers?: Record<string, string>;
  body?: unknown;
}

async function gw(method: string, path: string, opts: Opts = {}): Promise<Response> {
  const headers: Record<string, string> = { origin: ORIGIN, "x-captcha-token": "t", ...opts.headers };
  const xff = opts.xff === undefined ? "192.0.2.1" : opts.xff;
  if (xff !== null) headers["x-forwarded-for"] = xff;
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

const resolve = (opts: Opts = {}) => gw("POST", "/api/select", { body: CACHED, ...opts });
const detail = async (res: Response) => ((await res.json()) as { detail: string }).detail;

async function signIn(code = "g1", id = 1): Promise<{ jar: Jar; userId: string }> {
  github(code, id, `u${id}@example.org`, true);
  const jar = new Jar();
  await oauth(app, jar, "github", code);
  return { jar, userId: await signedInUserId(app, jar) };
}

async function createKey(jar: Jar, name = "ci"): Promise<string> {
  const res = await gw("POST", "/api/keys", { jar, body: { name } });
  expect(res.status).toBe(201);
  return ((await res.json()) as { key: string }).key;
}

const ipUnits = async () =>
  Object.fromEntries(
    (await sql<{ ip: string; units_used: number }>`SELECT ip, units_used FROM quota_ip_daily ORDER BY ip`.execute(db)).rows.map((r) => [r.ip, r.units_used]),
  );
const userCount = async () => (await sql<{ n: number }>`SELECT count(*)::int AS n FROM "user"`.execute(db)).rows[0]!.n;
const userUnits = async (userId: string) =>
  (await sql<{ u: number }>`SELECT units_used AS u FROM quota_user_daily WHERE user_id = ${userId}`.execute(db)).rows[0]?.u ?? 0;
const lastUpstreamIpHeader = () => upstream.at(-1)?.headers.get(CLIENT_IP_HEADER) ?? null;
const rateLimitKeys = async () => (await sql<{ key: string; count: number }>`SELECT key, count FROM "rateLimit" ORDER BY key`.execute(db)).rows;

// --- client IP resolution ------------------------------------------------------

describe("client IP resolution", () => {
  const local = new TrustedProxies(["127.0.0.1", "::1"]);

  test("an untrusted socket address is the client; X-Forwarded-For is ignored", () => {
    expect(resolveClientIp("198.51.100.7", "203.0.113.1", local)).toBe("198.51.100.7");
    expect(resolveClientIp("198.51.100.7", undefined, local)).toBe("198.51.100.7");
  });

  test("from a trusted proxy, the right-most entry is used and entries left of it are never read", () => {
    expect(resolveClientIp("127.0.0.1", "203.0.113.5", local)).toBe("203.0.113.5");
    expect(resolveClientIp("127.0.0.1", "6.6.6.6, 203.0.113.5", local)).toBe("203.0.113.5");
    expect(resolveClientIp("::1", "garbage, 203.0.113.5", local)).toBe("203.0.113.5");
  });

  test("multi-hop: trusted hops (exact or CIDR) are skipped right to left", () => {
    const hops = new TrustedProxies(["127.0.0.1", "10.0.0.0/8", "fd00::/8"]);
    expect(resolveClientIp("127.0.0.1", "6.6.6.6, 203.0.113.5, 10.1.2.3, 10.0.0.2", hops)).toBe("203.0.113.5");
    expect(resolveClientIp("10.9.9.9", "6.6.6.6, 203.0.113.5, fd12::1", hops)).toBe("203.0.113.5");
    // Every hop trusted (e.g. an internal caller): the left-most trusted address.
    expect(resolveClientIp("127.0.0.1", "10.0.0.5, 10.0.0.2", hops)).toBe("10.0.0.5");
    expect(resolveClientIp("127.0.0.1", null, hops)).toBe("127.0.0.1");
    // A malformed entry stops the walk at the nearest verified hop.
    expect(resolveClientIp("127.0.0.1", "203.0.113.5, not-an-ip, 10.0.0.2", hops)).toBe("10.0.0.2");
  });

  test("IPv4-mapped IPv6 is IPv4, also when matching trusted proxies; ports and brackets are stripped", () => {
    expect(resolveClientIp("::ffff:127.0.0.1", "203.0.113.5", local)).toBe("203.0.113.5");
    expect(resolveClientIp("::ffff:198.51.100.7", "203.0.113.5", local)).toBe("198.51.100.7");
    expect(resolveClientIp("127.0.0.1", "203.0.113.5:4711", local)).toBe("203.0.113.5");
    expect(resolveClientIp("127.0.0.1", "[2001:db8::1]:443", local)).toBe("2001:0db8:0000:0000:0000:0000:0000:0000");
  });

  test("IPv6 clients are bucketed by /64", () => {
    expect(clientKey("2001:db8:1:2:aaaa::1")).toBe("2001:0db8:0001:0002:0000:0000:0000:0000");
    expect(clientKey("2001:db8:1:2:ffff:ffff:ffff:ffff")).toBe(clientKey("2001:db8:1:2::9"));
    expect(clientKey("2001:db8:1:3::1")).not.toBe(clientKey("2001:db8:1:2::1"));
    expect(clientKey("fe80::1%eth0")).toBe("fe80:0000:0000:0000:0000:0000:0000:0000");
    expect(clientKey("nope")).toBeNull();
  });

  test("no socket address: unknown and untrusted, X-Forwarded-For ignored", () => {
    expect(resolveClientIp(undefined, "203.0.113.5", local)).toBe(UNKNOWN_CLIENT);
  });

  test("TRUSTED_PROXIES: default when unset or empty, CIDRs accepted, invalid entries fail", () => {
    expect(trustedProxiesFromEnv({})).toEqual(["127.0.0.1", "::1"]);
    expect(trustedProxiesFromEnv({ TRUSTED_PROXIES: " " })).toEqual(["127.0.0.1", "::1"]);
    expect(trustedProxiesFromEnv({ TRUSTED_PROXIES: "10.0.0.0/8, ::1" })).toEqual(["10.0.0.0/8", "::1"]);
    for (const bad of ["localhost", "10.0.0.0/33", "10.0.0.0/x", "::ffff:10.0.0.0/104"]) {
      expect(() => trustedProxiesFromEnv({ TRUSTED_PROXIES: bad })).toThrow("TRUSTED_PROXIES");
    }
  });
});

describe("client IP through the gateway (spoofing)", () => {
  test("X-Forwarded-For from an untrusted socket address is ignored", async () => {
    peer = "198.51.100.7";
    expect((await resolve({ xff: "203.0.113.1" })).status).toBe(200);
    expect(await ipUnits()).toEqual({ "198.51.100.7": 1 });
  });

  test("from the trusted proxy, the right-most untrusted entry is the client", async () => {
    expect((await resolve({ xff: "6.6.6.6, 203.0.113.5" })).status).toBe(200);
    expect(await ipUnits()).toEqual({ "203.0.113.5": 1 });
  });

  test("multi-hop header through several trusted proxies", async () => {
    build({}, ["127.0.0.1", "10.0.0.0/8"]);
    expect((await resolve({ xff: "6.6.6.6, 203.0.113.5, 10.0.0.3, 10.0.0.2" })).status).toBe(200);
    expect(await ipUnits()).toEqual({ "203.0.113.5": 1 });
  });

  test("a client-sent copy of the internal client-IP header is replaced", async () => {
    peer = "198.51.100.7";
    expect((await resolve({ headers: { [CLIENT_IP_HEADER]: "9.9.9.9" } })).status).toBe(200);
    expect(await ipUnits()).toEqual({ "198.51.100.7": 1 });
    expect(lastUpstreamIpHeader()).toBe("198.51.100.7");
  });

  test("Better Auth's sign-in limiter keys on the gateway's resolved IP", async () => {
    const signInSocial = (opts: Opts) => gw("POST", "/api/auth/sign-in/social", { body: { provider: "github", callbackURL: "/" }, ...opts });
    // Through the proxy: the right-most untrusted X-Forwarded-For entry, whatever the client prepends.
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await signInSocial({ xff: `10.0.${i}.1, 203.0.113.9` })).status);
    expect(statuses).toEqual([200, 200, 200, 429]); // sign-in: 3 per 10 s per IP
    // Directly from an untrusted address: spoofed X-Forwarded-For and internal header are both ignored.
    peer = "198.51.100.7";
    for (let i = 0; i < 3; i++) {
      const res = await signInSocial({ xff: `203.0.113.${100 + i}`, headers: { [CLIENT_IP_HEADER]: `203.0.113.${200 + i}` } });
      expect(res.status).toBe(200);
    }
    expect((await signInSocial({ xff: "203.0.113.150" })).status).toBe(429);
    // IPv6: the same /64 bucket as the gateway's own limits.
    peer = "2001:db8:1:2::1";
    expect((await signInSocial({ xff: null })).status).toBe(200);
    peer = "2001:db8:1:2::2";
    expect((await signInSocial({ xff: null })).status).toBe(200);

    const keys = await rateLimitKeys();
    expect(keys).toContainEqual({ key: "203.0.113.9|/sign-in/social", count: 3 });
    expect(keys).toContainEqual({ key: "198.51.100.7|/sign-in/social", count: 3 });
    expect(keys).toContainEqual({ key: `${clientKey("2001:db8:1:2::1")}|/sign-in/social`, count: 2 });
    expect(keys.map((k) => k.key.split("|")[0])).toEqual(["198.51.100.7", "2001:0db8:0001:0002:0000:0000:0000:0000", "203.0.113.9"]);
  });
});

// --- Per-IP cap on anonymous use ---------------------------------------------------

describe("Per-IP cap on anonymous use", () => {
  test("defaults: 30 per IP; bursts 3/min anonymous, 20/min signed in and per key; open routes 60/min per IP", () => {
    expect(limitsConfig()).toMatchObject({
      anonymousIpDailyUnits: 30,
      burst: { windowSeconds: 60, anonymous: 3, signed_in: 20, api_key: 20 },
      openRoutePerIp: { windowSeconds: 60, limit: 60 },
    });
    expect(DEFAULT_LIMITS.anonymousIpDailyUnits).toBe(30);
    expect(() => limitsConfig({ burst: { anonymous: 0 } })).toThrow(RangeError);
    expect(() => limitsConfig({ openRoutePerIp: { windowSeconds: 0 } })).toThrow(RangeError);
    expect(() => limitsConfig({ anonymousIpDailyUnits: -1 })).toThrow(RangeError);
  });

  test("Cleared cookies: after 30 anonymous resolves from one IP, a fresh browser is rejected with 429 and no identity is created", async () => {
    // 30 browsers at one IP (a fresh identity each, as after clearing cookies).
    for (let i = 0; i < 30; i++) expect([i, (await resolve({ jar: new Jar() })).status]).toEqual([i, 200]);
    expect(await ipUnits()).toEqual({ "192.0.2.1": 30 });
    expect(await userCount()).toBe(30);

    const fresh = new Jar();
    const res = await resolve({ jar: fresh });
    expect(res.status).toBe(429);
    expect(await detail(res)).toContain("Per-IP daily cap exceeded");
    expect(res.headers.get("retry-after")).toBe(String(secondsUntilReset(clock)));
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(fresh.cookies.size).toBe(0);
    expect(await userCount()).toBe(30); // the capped request minted no identity
    expect(upstream).toHaveLength(30);
    expect(await ipUnits()).toEqual({ "192.0.2.1": 30 });
  });

  test("an existing anonymous identity at a capped IP is rejected and its own quota is not charged", async () => {
    build({ anonymousIpDailyUnits: 2 });
    const a = new Jar();
    expect((await resolve({ jar: a })).status).toBe(200);
    clock = new Date(T0.getTime() + 60_000);
    expect((await resolve({ jar: new Jar() })).status).toBe(200);
    clock = new Date(T0.getTime() + 120_000);
    const res = await resolve({ jar: a });
    expect(res.status).toBe(429);
    expect(await detail(res)).toContain("anonymous users at one IP address share 2 units");
    const anonId = (await sql<{ id: string }>`SELECT id FROM "user" ORDER BY "createdAt" LIMIT 1`.execute(db)).rows[0]!.id;
    expect(await userUnits(anonId)).toBe(1);
  });

  test("the atomic reservation holds even when the pre-identity check passes (identity known, cap reached concurrently)", async () => {
    build({ anonymousIpDailyUnits: 3, burst: { anonymous: 100 } });
    const results = await Promise.all(Array.from({ length: 6 }, () => resolve({ jar: new Jar() })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 200, 429, 429, 429]);
    expect(await ipUnits()).toEqual({ "192.0.2.1": 3 });
    // Requests that lost the race got their user units back.
    const total = (await sql<{ n: number }>`SELECT coalesce(sum(units_used), 0)::int AS n FROM quota_user_daily`.execute(db)).rows[0]!.n;
    expect(total).toBe(3);
  });

  test("other IPs, signed-in users and API keys at the capped IP are not affected", async () => {
    build({ anonymousIpDailyUnits: 1 });
    expect((await resolve({ jar: new Jar() })).status).toBe(200);
    expect((await resolve({ jar: new Jar() })).status).toBe(429);
    expect((await resolve({ jar: new Jar(), xff: "192.0.2.2" })).status).toBe(200);

    const { jar, userId } = await signIn();
    const key = await createKey(jar);
    expect((await resolve({ jar })).status).toBe(200);
    expect((await resolve({ headers: { "x-api-key": key } })).status).toBe(200);
    expect(await userUnits(userId)).toBe(2);
    expect(await ipUnits()).toEqual({ "192.0.2.1": 1, "192.0.2.2": 1 });
  });

  test("units are refunded to the IP cap on 5xx, and the cap resets at 00:00 UTC", async () => {
    build({ anonymousIpDailyUnits: 1 });
    respond = async () => new Response("down", { status: 503 });
    expect((await resolve({ jar: new Jar() })).status).toBe(503);
    expect(await ipUnits()).toEqual({ "192.0.2.1": 0 });
    respond = async () => Response.json({ ok: true });
    expect((await resolve({ jar: new Jar() })).status).toBe(200);
    expect((await resolve({ jar: new Jar() })).status).toBe(429);
    clock = new Date("2026-10-29T00:00:00Z");
    expect((await resolve({ jar: new Jar() })).status).toBe(200);
  });
});

// --- Burst rate limits ----------------------------------------------------------------

describe("Burst rate limits", () => {
  test("Runaway script: one key over its burst gets 429; the owner's other key and browser session still pass", async () => {
    const { jar, userId } = await signIn();
    const runaway = await createKey(jar, "runaway");
    const other = await createKey(jar, "other");
    for (let i = 0; i < 20; i++) expect([i, (await resolve({ headers: { "x-api-key": runaway } })).status]).toEqual([i, 200]);
    const res = await resolve({ headers: { "x-api-key": runaway } });
    expect(res.status).toBe(429);
    expect(await detail(res)).toContain("Burst limit exceeded: this API key may make 20 requests per minute");
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await userUnits(userId)).toBe(20); // the rejected request was not charged

    expect((await resolve({ headers: { "x-api-key": other } })).status).toBe(200);
    expect((await resolve({ jar })).status).toBe(200);
    expect(await userUnits(userId)).toBe(22);
  });

  test("anonymous identity: 3 per minute, then Retry-After until the sliding window admits one more", async () => {
    const jar = new Jar();
    for (let i = 0; i < 3; i++) expect((await resolve({ jar })).status).toBe(200);
    const res = await resolve({ jar });
    expect(res.status).toBe(429);
    expect(await detail(res)).toContain("anonymous users may make 3 requests per minute");
    // Full window at t=0: next window, then until 3 * (1 - e/60) + 1 <= 3, i.e. e = 20 s.
    expect(res.headers.get("retry-after")).toBe("80");
    expect(await userCount()).toBe(1);
    expect(upstream).toHaveLength(3);

    clock = new Date(T0.getTime() + 79_000);
    expect((await resolve({ jar })).status).toBe(429);
    clock = new Date(T0.getTime() + 80_000);
    expect((await resolve({ jar })).status).toBe(200);
    // A different anonymous identity has its own bucket.
    clock = new Date(T0);
    expect((await resolve({ jar: new Jar() })).status).toBe(200);
  });

  test("signed-in identity: 20 per minute", async () => {
    const { jar } = await signIn();
    for (let i = 0; i < 20; i++) expect((await resolve({ jar })).status).toBe(200);
    const res = await resolve({ jar });
    expect(res.status).toBe(429);
    expect(await detail(res)).toContain("signed-in users may make 20 requests per minute");
  });

  test("attempts that fail upstream still count; free catalog reads do not count against the identity", async () => {
    const { jar } = await signIn();
    for (let i = 0; i < 30; i++) expect((await gw("GET", "/api/catalog", { jar, xff: `192.0.2.${i}` })).status).toBe(200);
    respond = async () => new Response("down", { status: 502 });
    for (let i = 0; i < 20; i++) expect((await resolve({ jar })).status).toBe(502);
    respond = async () => Response.json({ ok: true });
    expect((await resolve({ jar })).status).toBe(429);
  });

  test("sliding window: the previous window's count fades linearly", async () => {
    build({ burst: { signed_in: 10 } });
    const { jar } = await signIn();
    clock = new Date(T0.getTime() + 30_000);
    for (let i = 0; i < 10; i++) expect((await resolve({ jar })).status).toBe(200);
    // Next window, 15 s in: estimate 10 * 0.75 = 7.5, so 2 more fit (7.5 + 2 <= 10), not 3.
    clock = new Date(T0.getTime() + 75_000);
    expect((await resolve({ jar })).status).toBe(200);
    expect((await resolve({ jar })).status).toBe(200);
    const res = await resolve({ jar });
    expect(res.status).toBe(429);
    // Wait until 10 * (1 - e/60) + 3 <= 10: e = 18 s, i.e. 3 s from now.
    expect(res.headers.get("retry-after")).toBe("3");
    clock = new Date(T0.getTime() + 78_000);
    expect((await resolve({ jar })).status).toBe(200);
  });

  test("burstRetryAfterMs", () => {
    expect(burstRetryAfterMs(3, 0, 3, 0, 60_000)).toBeCloseTo(80_000, 3);
    expect(burstRetryAfterMs(2, 10, 10, 15_000, 60_000)).toBeCloseTo(3_000, 3);
    expect(burstRetryAfterMs(0, 5, 5, 0, 60_000)).toBeCloseTo(12_000, 3);
    // Limit 1: the previous request must fade completely, i.e. the end of the next window.
    expect(burstRetryAfterMs(1, 0, 1, 30_000, 60_000)).toBeCloseTo(90_000, 3);
    expect(burstRetryAfterMs(0, 0, 3, 10_000, 60_000)).toBe(0);
  });
});

describe("Open routes per-IP rate limit", () => {
  test("all open routes share a per-IP limit; other IPs are unaffected; the window slides", async () => {
    build({ openRoutePerIp: { limit: 5 } });
    for (const path of ["/api/health", "/api/catalog", "/api/catalog/abc", "/api/engines", "/api/presets"]) {
      expect([path, (await gw("GET", path)).status]).toEqual([path, 200]);
    }
    const res = await gw("GET", "/api/catalog");
    expect(res.status).toBe(429);
    // Full window at t=0: next window, then until 5 * (1 - e/60) + 1 <= 5, i.e. e = 12 s.
    expect(await detail(res)).toBe("Rate limit exceeded: open routes allow 5 requests per minute per IP address. Retry in 72 s.");
    expect(res.headers.get("retry-after")).toBe("72");
    expect((await gw("GET", "/api/catalog", { xff: "192.0.2.2" })).status).toBe(200);
    expect(await userCount()).toBe(0);

    // Next window at 0 s: the previous 5 still weigh fully; 1 fits after 60 * (1 - 4/5) = 12 s.
    clock = new Date(T0.getTime() + 60_000);
    const again = await gw("GET", "/api/engines");
    expect(again.status).toBe(429);
    expect(again.headers.get("retry-after")).toBe("12");
    clock = new Date(T0.getTime() + 72_000);
    expect((await gw("GET", "/api/engines")).status).toBe(200);
  });

  test("the limit applies to signed-in callers too, keyed by IP", async () => {
    build({ openRoutePerIp: { limit: 2 } });
    const { jar } = await signIn();
    expect((await gw("GET", "/api/presets", { jar })).status).toBe(200);
    expect((await gw("GET", "/api/presets")).status).toBe(200);
    expect((await gw("GET", "/api/presets", { jar })).status).toBe(429);
  });
});
