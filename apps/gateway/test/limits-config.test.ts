/**
 * Task 4.6: limits from the environment (`limitsConfigFromEnv`) and the
 * log-only mode (`QRB_LIMITS_MODE=log`): limits that would reject only log,
 * counters still increase, policy rejections still apply.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { sql } from "kysely";
import { acceptCaptcha, stubCaptcha } from "./helpers/captcha";
import { createApp } from "../src/app";
import { createAuth, type GatewayAuth } from "../src/auth";
import { createTestDatabase, type Database } from "../src/db";
import { migrateUp } from "../src/db/migrator";
import { DEFAULT_LIMITS, limitsConfig, limitsConfigFromEnv, type LimitsOverrides } from "../src/limits/config";
import { baseConfig, fakeProviders, github, identities, Jar, oauth, ORIGIN, realFetch, signedInUserId, unexpected, type App } from "./helpers/providers";

let db: Database;
let auth: GatewayAuth;
let app: App;
let clock: Date;
let warn: ReturnType<typeof spyOn>;
const captcha = stubCaptcha();

const T0 = new Date("2026-10-28T12:00:00Z");

function build(limits: LimitsOverrides) {
  app = createApp({
    captcha,
    auth,
    db,
    limits,
    now: () => clock,
    clientAddress: () => "127.0.0.1",
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
  captcha.calls.length = 0;
  captcha.mode = "ok";
  clock = new Date(T0);
  db = createTestDatabase();
  await migrateUp(db);
  auth = createAuth(db, baseConfig, { logLevel: "error" });
  warn = spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(async () => {
  warn.mockRestore();
  expect(unexpected).toEqual([]);
  await db.destroy();
});

const CACHED = { circuit_qasm: "OPENQASM 3.0; qubit[2] q; h q[0]; cx q[0], q[1];", force_refresh: false };

async function gw(method: string, path: string, opts: { jar?: Jar; xff?: string; token?: string; headers?: Record<string, string>; body?: unknown } = {}) {
  const headers: Record<string, string> = {
    origin: ORIGIN,
    "x-captcha-token": opts.token ?? "t",
    "x-forwarded-for": opts.xff ?? "192.0.2.1",
    ...opts.headers,
  };
  const cookie = opts.jar?.header();
  if (cookie) headers.cookie = cookie;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await app.request(`${ORIGIN}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  opts.jar?.store(res);
  return res;
}
const resolve = (opts: Parameters<typeof gw>[2] = {}) => gw("POST", "/api/select", { body: CACHED, ...opts });

/** Parsed `limit_would_reject` log lines. */
interface LogLine {
  event: string;
  mode: string;
  limit: string;
  key: string;
  status: number;
}
const logged = (): LogLine[] =>
  warn.mock.calls
    .map((c: unknown[]) => String(c[0]))
    .filter((l: string) => l.includes("limit_would_reject"))
    .map((l: string) => JSON.parse(l) as LogLine);
const loggedLimits = () => new Set(logged().map((l) => l.limit));

const userUnits = async () => (await sql<{ u: number }>`SELECT coalesce(sum(units_used), 0)::int AS u FROM quota_user_daily`.execute(db)).rows[0]!.u;
const ipUnits = async () => (await sql<{ u: number }>`SELECT coalesce(sum(units_used), 0)::int AS u FROM quota_ip_daily`.execute(db)).rows[0]!.u;
const burstCount = async (scopePrefix: string) =>
  (await sql<{ n: number }>`SELECT coalesce(sum(count), 0)::int AS n FROM burst_bucket WHERE scope LIKE ${scopePrefix + "%"}`.execute(db)).rows[0]!.n;

async function signIn(code = "g1", id = 1): Promise<Jar> {
  github(code, id, `u${id}@example.org`, true);
  const jar = new Jar();
  await oauth(app, jar, "github", code);
  expect(await signedInUserId(app, jar)).toBeTruthy();
  return jar;
}

// --- environment ---------------------------------------------------------------

describe("limitsConfigFromEnv", () => {
  test("empty environment gives the design defaults, enforcing", () => {
    expect(limitsConfigFromEnv({})).toEqual(limitsConfig());
    expect(limitsConfigFromEnv({})).toEqual({ ...DEFAULT_LIMITS, mode: "enforce" });
    expect(limitsConfigFromEnv({ QRB_LIMIT_ANON_DAILY: "", QRB_LIMITS_MODE: " " }).dailyUnits.anonymous).toBe(10);
  });

  test("every variable maps onto its limit", () => {
    expect(
      limitsConfigFromEnv({
        QRB_LIMITS_MODE: "log",
        QRB_LIMIT_ANON_DAILY: "11",
        QRB_LIMIT_SIGNED_IN_DAILY: "201",
        QRB_LIMIT_LIVE_REFRESH_WEIGHT: "6",
        QRB_LIMIT_ANON_IP_DAILY: "31",
        QRB_LIMIT_BURST_WINDOW_SECONDS: "30",
        QRB_LIMIT_BURST_ANON: "4",
        QRB_LIMIT_BURST_SIGNED_IN: "21",
        QRB_LIMIT_BURST_API_KEY: "22",
        QRB_LIMIT_OPEN_WINDOW_SECONDS: "10",
        QRB_LIMIT_OPEN_PER_IP: "61",
      }),
    ).toEqual({
      mode: "log",
      dailyUnits: { anonymous: 11, signed_in: 201 },
      liveRefreshWeight: 6,
      anonymousIpDailyUnits: 31,
      burst: { windowSeconds: 30, anonymous: 4, signed_in: 21, api_key: 22 },
      openRoutePerIp: { windowSeconds: 10, limit: 61 },
    });
  });

  test("a partial environment keeps the other defaults; 0 is allowed for daily quotas", () => {
    const c = limitsConfigFromEnv({ QRB_LIMIT_SIGNED_IN_DAILY: "0", QRB_LIMITS_MODE: "LOG" });
    expect(c.mode).toBe("log");
    expect(c.dailyUnits).toEqual({ anonymous: 10, signed_in: 0 });
    expect(c.burst).toEqual(DEFAULT_LIMITS.burst);
  });

  test("invalid values throw, naming the variable", () => {
    const bad: [string, string][] = [
      ["QRB_LIMITS_MODE", "monitor"],
      ["QRB_LIMIT_ANON_DAILY", "abc"],
      ["QRB_LIMIT_ANON_DAILY", "-1"],
      ["QRB_LIMIT_SIGNED_IN_DAILY", "1.5"],
      ["QRB_LIMIT_LIVE_REFRESH_WEIGHT", "0"],
      ["QRB_LIMIT_ANON_IP_DAILY", "1e3"],
      ["QRB_LIMIT_BURST_WINDOW_SECONDS", "0"],
      ["QRB_LIMIT_BURST_ANON", "0"],
      ["QRB_LIMIT_BURST_SIGNED_IN", "x"],
      ["QRB_LIMIT_BURST_API_KEY", "-3"],
      ["QRB_LIMIT_OPEN_WINDOW_SECONDS", "0"],
      ["QRB_LIMIT_OPEN_PER_IP", "many"],
    ];
    for (const [name, value] of bad) {
      expect(() => limitsConfigFromEnv({ [name]: value })).toThrow(name);
    }
  });

  test("createApp without explicit limits reads the environment at creation", () => {
    const old = process.env.QRB_LIMIT_BURST_ANON;
    process.env.QRB_LIMIT_BURST_ANON = "nope";
    try {
      expect(() => createApp({ captcha: acceptCaptcha, auth, db })).toThrow("QRB_LIMIT_BURST_ANON");
    } finally {
      if (old === undefined) delete process.env.QRB_LIMIT_BURST_ANON;
      else process.env.QRB_LIMIT_BURST_ANON = old;
    }
  });
});

// --- log-only mode ---------------------------------------------------------------

const roomy = { anonymousIpDailyUnits: 1000, dailyUnits: { anonymous: 1000, signed_in: 1000 }, burst: { anonymous: 1000, signed_in: 1000, api_key: 1000 }, openRoutePerIp: { limit: 1000 } };

describe("log-only mode", () => {
  test("over the user quota: no 429, counter keeps growing, headers show 0 remaining, one log line per excess request", async () => {
    build({ ...roomy, mode: "log", dailyUnits: { anonymous: 2 } });
    const jar = new Jar();
    const statuses: number[] = [];
    let last!: Response;
    for (let i = 0; i < 4; i++) {
      last = await resolve({ jar });
      statuses.push(last.status);
    }
    expect(statuses).toEqual([200, 200, 200, 200]);
    expect(await userUnits()).toBe(4);
    expect(last.headers.get("X-Quota-Limit")).toBe("2");
    expect(last.headers.get("X-Quota-Remaining")).toBe("0");
    const lines = logged().filter((l) => l.limit === "user_daily");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ event: "limit_would_reject", mode: "log", status: 429 });
    expect(lines[0]!.key).toBeTruthy();
  });

  test("over the signed-in quota is logged too", async () => {
    build({ ...roomy, mode: "log", dailyUnits: { signed_in: 1 } });
    const jar = await signIn();
    expect((await resolve({ jar })).status).toBe(200);
    expect((await resolve({ jar })).status).toBe(200);
    expect(await userUnits()).toBe(2);
    expect(loggedLimits()).toEqual(new Set(["user_daily"]));
  });

  test("over the per-IP cap: no 429 from the gate or the reservation, IP counter keeps growing", async () => {
    build({ ...roomy, mode: "log", anonymousIpDailyUnits: 2 });
    for (let i = 0; i < 4; i++) expect((await resolve({ jar: new Jar() })).status).toBe(200);
    expect(await ipUnits()).toBe(4);
    expect(await userUnits()).toBe(4); // user units are kept too (nothing is given back)
    expect(loggedLimits()).toEqual(new Set(["ip_daily_gate", "ip_daily"]));
  });

  test("over the identity burst: no 429, bucket keeps counting", async () => {
    build({ ...roomy, mode: "log", burst: { anonymous: 1 } });
    const jar = new Jar();
    for (let i = 0; i < 4; i++) expect((await resolve({ jar })).status).toBe(200);
    expect(await burstCount("burst:anonymous")).toBe(4);
    expect(logged().filter((l) => l.limit === "burst:anonymous")).toHaveLength(3);
  });

  test("over an API key's burst: no 429, bucket keeps counting", async () => {
    build({ ...roomy, mode: "log", burst: { api_key: 1 } });
    const jar = await signIn();
    const created = await gw("POST", "/api/keys", { jar, body: { name: "ci" } });
    expect(created.status).toBe(201);
    const key = ((await created.json()) as { key: string }).key;
    for (let i = 0; i < 3; i++) expect((await resolve({ headers: { "x-api-key": key } })).status).toBe(200);
    expect(await burstCount("burst:api_key")).toBe(3);
    expect(loggedLimits()).toEqual(new Set(["burst:api_key"]));
  });

  test("over the open-route per-IP limit: no 429, bucket keeps counting", async () => {
    build({ ...roomy, mode: "log", openRoutePerIp: { limit: 2 } });
    for (let i = 0; i < 5; i++) expect((await gw("GET", "/api/health")).status).toBe(200);
    expect(await burstCount("open:ip")).toBe(5);
    const lines = logged().filter((l) => l.limit === "open_route_ip");
    expect(lines).toHaveLength(3);
    expect(lines[0]!.key).toBe("192.0.2.1");
  });

  test("enforce mode is unchanged: the same limits reject with 429 and do not count", async () => {
    build({ ...roomy, dailyUnits: { anonymous: 2 }, openRoutePerIp: { limit: 2 }, burst: { anonymous: 1000 } });
    const jar = new Jar();
    expect([(await resolve({ jar })).status, (await resolve({ jar })).status, (await resolve({ jar })).status]).toEqual([200, 200, 429]);
    expect(await userUnits()).toBe(2);
    for (let i = 0; i < 2; i++) await gw("GET", "/api/health");
    expect((await gw("GET", "/api/health")).status).toBe(429);
    expect(await burstCount("open:ip")).toBe(2);
    expect(logged()).toEqual([]);
  });

  test("policy rejections still apply: CAPTCHA 403, anonymous live refresh 403, 401 without identity, bad key 401, 422", async () => {
    build({ ...roomy, mode: "log", dailyUnits: { anonymous: 0 }, anonymousIpDailyUnits: 0 });
    expect((await resolve({ token: "bad", jar: new Jar() })).status).toBe(403);
    expect((await gw("POST", "/api/select", { jar: new Jar(), body: { ...CACHED, force_refresh: true } })).status).toBe(403);
    expect((await gw("GET", "/api/catalog?force_refresh=true")).status).toBe(403);
    expect((await gw("POST", "/api/select", { headers: { "x-api-key": "qrb_nonsense" }, body: CACHED })).status).toBe(401);
    expect((await gw("POST", "/api/select", { jar: new Jar(), body: { ...CACHED, snapshot_path: "/etc/passwd" } })).status).toBe(422);
    // Nothing above reached the quota.
    expect(await userUnits()).toBe(0);
    expect(await ipUnits()).toBe(0);
  });
});
