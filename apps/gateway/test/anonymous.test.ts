/**
 * Callers without an account are identified by their client IP: no user,
 * session or cookie is created, everyone at one address shares one budget,
 * and a session or an API key always takes precedence.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "kysely";
import { createApp } from "../src/app";
import { createAuth, type GatewayAuth } from "../src/auth";
import { ipIdentity } from "../src/auth/anonymous";
import { createTestDatabase, type Database } from "../src/db";
import { utcDay } from "../src/db/counters";
import { migrateUp } from "../src/db/migrator";
import { DEFAULT_LIMITS } from "../src/limits/config";
import { baseConfig, fakeProviders, github, identities, Jar, oauth, ORIGIN, realFetch, signedInUserId, unexpected, type App, BEHIND_PROXY } from "./helpers/providers";

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

const CACHED = { circuit_qasm: "OPENQASM 3.0; qubit[2] q; h q[0]; cx q[0], q[1];", force_refresh: false };

async function gw(method: "GET" | "POST", path: string, body?: unknown, opts: { ip?: string; jar?: Jar; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { origin: ORIGIN, "x-forwarded-for": opts.ip ?? "192.0.2.1", ...opts.headers };
  const cookie = opts.jar?.header();
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await app.request(`${ORIGIN}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  opts.jar?.store(res);
  return res;
}

const userRows = async () => (await sql<{ n: number }>`SELECT count(*)::int AS n FROM "user"`.execute(db)).rows[0]!.n;
const sessionRows = async () => (await sql<{ n: number }>`SELECT count(*)::int AS n FROM "session"`.execute(db)).rows[0]!.n;
const unitsToday = async (key: string) =>
  (await sql<{ units_used: number }>`SELECT units_used FROM quota_user_daily WHERE user_id = ${key} AND day = ${utcDay()}::date`.execute(db)).rows[0]
    ?.units_used ?? 0;
const lastUpstreamUser = () => upstreamSeen.at(-1)!.headers.get("x-qrb-user-id");

describe("Keyless callers", () => {
  test("a resolve with no session and no key is forwarded as ip:<address>, creating no user, session or cookie", async () => {
    const res = await gw("POST", "/api/select", CACHED);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(lastUpstreamUser()).toBe("ip:192.0.2.1");
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(await userRows()).toBe(0);
    expect(await sessionRows()).toBe(0);
    expect(await unitsToday("ip:192.0.2.1")).toBe(1);
  });

  test("everyone at one address shares one budget; another address has its own", async () => {
    await gw("POST", "/api/select", CACHED, { jar: new Jar() });
    await gw("POST", "/api/instance", CACHED, { jar: new Jar() });
    await gw("POST", "/api/select", CACHED, { ip: "192.0.2.77" });
    expect(await unitsToday("ip:192.0.2.1")).toBe(2);
    expect(await unitsToday("ip:192.0.2.77")).toBe(1);
  });

  test("IPv6 addresses in one /64 are one identity", async () => {
    await gw("POST", "/api/select", CACHED, { ip: "2001:db8:0:1::1" });
    await gw("POST", "/api/select", CACHED, { ip: "2001:db8:0:1:ffff::2" });
    const key = lastUpstreamUser()!;
    expect(key).toBe("ip:2001:0db8:0000:0001:0000:0000:0000:0000");
    expect(await unitsToday(key)).toBe(2);
  });

  test("a live refresh needs no sign-in and costs the live-refresh weight", async () => {
    const res = await gw("POST", "/api/select", { circuit_qasm: CACHED.circuit_qasm, force_refresh: true });
    expect(res.status).toBe(200);
    expect(await unitsToday("ip:192.0.2.1")).toBe(DEFAULT_LIMITS.liveRefreshWeight);

    const catalog = await gw("GET", "/api/catalog?force_refresh=true");
    expect(catalog.status).toBe(200);
    expect(await unitsToday("ip:192.0.2.1")).toBe(2 * DEFAULT_LIMITS.liveRefreshWeight);
  });

  test("a snapshot request (live: false) costs 1 unit even with force_refresh left at its default", async () => {
    expect((await gw("POST", "/api/instance", { circuit_qasm: CACHED.circuit_qasm, live: false })).status).toBe(200);
    expect(await unitsToday("ip:192.0.2.1")).toBe(1);
  });

  test("cached catalog reads, presets and engines are free and create nothing", async () => {
    for (const path of ["/api/catalog", "/api/catalog/ibm.ibm_aachen", "/api/catalog/ibm.ibm_aachen/topology", "/api/presets", "/api/engines"]) {
      expect((await gw("GET", path)).status).toBe(200);
    }
    expect(await unitsToday("ip:192.0.2.1")).toBe(0);
    expect(await userRows()).toBe(0);
  });

  test("ipIdentity falls back to the shared unknown bucket without an address", () => {
    expect(ipIdentity(undefined)).toBe("ip:unknown");
  });
});

describe("Precedence", () => {
  test("a signed-in session is charged to the account, not the IP", async () => {
    github("g1", 1001, "ana@example.org", true);
    const jar = new Jar();
    await oauth(app, jar, "github", "g1");
    const userId = await signedInUserId(app, jar);

    expect((await gw("POST", "/api/select", CACHED, { jar })).status).toBe(200);
    expect(lastUpstreamUser()).toBe(userId);
    expect(await unitsToday(userId)).toBe(1);
    expect(await unitsToday("ip:192.0.2.1")).toBe(0);
  });

  test("an API key is charged to its owner; an invalid key is 401, never a fallback to the IP", async () => {
    github("g1", 1002, "bo@example.org", true);
    const jar = new Jar();
    await oauth(app, jar, "github", "g1");
    const userId = await signedInUserId(app, jar);
    const created = await gw("POST", "/api/keys", { name: "script" }, { jar });
    expect(created.status).toBe(201);
    const { key } = (await created.json()) as { key: string };

    expect((await gw("POST", "/api/select", CACHED, { headers: { "x-api-key": key } })).status).toBe(200);
    expect(lastUpstreamUser()).toBe(userId);

    const bad = await gw("POST", "/api/select", CACHED, { headers: { "x-api-key": "qrb_not-a-key" } });
    expect(bad.status).toBe(401);
    expect(await unitsToday("ip:192.0.2.1")).toBe(0);
  });
});
