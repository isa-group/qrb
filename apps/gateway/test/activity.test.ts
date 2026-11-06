/**
 * Account activity: signed-in users' counted requests and binds are recorded, readable by their
 * own session only, paged and exportable as CSV, deletable, and kept 30 days. Keyless callers are
 * never recorded.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "kysely";
import { activityIdle, bindSummary, purgeActivity, PAGE_SIZE } from "../src/activity";
import { createApp } from "../src/app";
import { createAuth, type GatewayAuth } from "../src/auth";
import { createTestDatabase, type Database } from "../src/db";
import { migrateUp } from "../src/db/migrator";
import { baseConfig, fakeProviders, github, identities, Jar, oauth, ORIGIN, realFetch, signedInUserId, unexpected, type App, BEHIND_PROXY } from "./helpers/providers";

let db: Database;
let auth: GatewayAuth;
let app: App;
let clock: Date;
let status = 200;

const SELECT_ANSWER = {
  result: { feasibility: "FEASIBLE", solutions: [{ binding: { task: "ibm.ibm_aachen" } }], provenance: { engine_id: "minizinc-csp" } },
  candidates: [
    { candidate_id: "ibm.ibm_aachen", name: "ibm_aachen", provider_id: "ibm" },
    { candidate_id: "braket.Garnet", name: "Garnet", provider_id: "braket" },
  ],
  source: { mode: "live", as_of: "2026-10-28T11:59:00Z", cache_hit: true },
};

function build(limits = {}) {
  app = createApp({
    ...BEHIND_PROXY,
    auth,
    db,
    limits: { burst: { anonymous: 1000, signed_in: 1000, api_key: 1000 }, openRoutePerIp: { limit: 1000 }, ...limits },
    now: () => clock,
    upstreamUrl: "http://upstream.test:8000",
    secret: "s",
    fetch: async (r) => {
      if (status >= 500) return new Response("down", { status });
      return Response.json(new URL(r.url).pathname === "/select" ? SELECT_ANSWER : { ok: true });
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
  status = 200;
  clock = new Date("2026-10-28T12:00:00Z");
  db = createTestDatabase();
  await migrateUp(db);
  auth = createAuth(db, baseConfig, { logLevel: "error" });
  build();
});
afterEach(async () => {
  await activityIdle();
  expect(unexpected).toEqual([]);
  await db.destroy();
});

const QASM = "OPENQASM 3.0; qubit[2] q; h q[0]; cx q[0], q[1];";
const BODY = { circuit_qasm: QASM, preferences: { weights: { cost: 0.6, queue: 0.4 } }, shots: 2048, force_refresh: false };

async function gw(method: string, path: string, opts: { jar?: Jar; headers?: Record<string, string>; body?: unknown; ip?: string } = {}) {
  const headers: Record<string, string> = { origin: ORIGIN, "x-forwarded-for": opts.ip ?? "192.0.2.1", ...opts.headers };
  const cookie = opts.jar?.header();
  if (cookie) headers.cookie = cookie;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await app.request(`${ORIGIN}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  opts.jar?.store(res);
  return res;
}

async function signIn(code = "g1", id = 1) {
  github(code, id, `u${id}@example.org`, true);
  const jar = new Jar();
  await oauth(app, jar, "github", code);
  return { jar, userId: await signedInUserId(app, jar) };
}

async function createKey(jar: Jar) {
  const res = await gw("POST", "/api/keys", { jar, body: {} });
  expect(res.status).toBe(201);
  return (await res.json()) as { key: string; start: string };
}

const select = async (opts: Parameters<typeof gw>[2] = {}) => {
  const res = await gw("POST", "/api/select", { body: BODY, ...opts });
  await res.text();
  await activityIdle();
  return res;
};
const rows = async (table: "request_log" | "bind_history") => (await sql<{ n: number }>`SELECT count(*)::int AS n FROM ${sql.table(table)}`.execute(db)).rows[0]!.n;
const json = async <T>(res: Response) => (await res.json()) as T;

describe("recording", () => {
  test("a signed-in bind from the browser is logged and stored with its request and a summary; the caller's answer is untouched", async () => {
    const { jar } = await signIn();
    const res = await gw("POST", "/api/select", { jar, body: BODY });
    expect(await res.json()).toEqual(SELECT_ANSWER);
    await activityIdle();

    const log = await json<{ requests: unknown[] }>(await gw("GET", "/api/history/requests", { jar }));
    expect(log.requests).toEqual([
      { id: expect.any(String), at: expect.any(String), source: "browser", apiKeyStart: null, method: "POST", path: "/select", cost: 1, status: 200, durationMs: expect.any(Number) },
    ]);
    const binds = await json<{ binds: unknown[]; next: null }>(await gw("GET", "/api/history/binds", { jar }));
    expect(binds.next).toBeNull();
    expect(binds.binds).toEqual([
      {
        id: expect.any(String),
        at: "2026-10-28T12:00:00.000Z",
        source: "browser",
        apiKeyStart: null,
        cost: 1,
        preferences: BODY.preferences,
        shots: 2048,
        live: true,
        status: "done",
        error: null,
        summary: {
          feasibility: "FEASIBLE",
          solutions: 1,
          candidates: 2,
          winners: [{ id: "ibm.ibm_aachen", name: "ibm_aachen", provider: "ibm" }],
          engine: "minizinc-csp",
          source: { mode: "live", as_of: "2026-10-28T11:59:00Z", cache_hit: true },
        },
      },
    ]);
  });

  test("keyless callers are never recorded", async () => {
    expect((await select()).status).toBe(200);
    expect(await rows("request_log")).toBe(0);
    expect(await rows("bind_history")).toBe(0);
  });

  test("an API key's requests are labelled with the key, and the label survives revoking it", async () => {
    const { jar } = await signIn();
    const k = await createKey(jar);
    await select({ headers: { "x-api-key": k.key } });
    const listed = await json<{ keys: { id: string }[] }>(await gw("GET", "/api/keys", { jar }));
    await gw("DELETE", `/api/keys/${listed.keys[0]!.id}`, { jar });
    const log = await json<{ requests: { source: string; apiKeyStart: string }[] }>(await gw("GET", "/api/history/requests", { jar }));
    expect(log.requests[0]).toMatchObject({ source: "key", apiKeyStart: k.start });
  });

  test("a quota 429 is logged at 0 units; a refunded 5xx is logged at 0 units and stores no bind", async () => {
    build({ dailyUnits: { signed_in: 1 } });
    const { jar } = await signIn();
    await select({ jar });
    expect((await select({ jar })).status).toBe(429);
    clock = new Date("2026-10-29T12:00:00Z");
    status = 503;
    expect((await select({ jar })).status).toBe(503);
    const log = await json<{ requests: { status: number; cost: number }[] }>(await gw("GET", "/api/history/requests", { jar }));
    expect(log.requests.map((r) => [r.status, r.cost])).toEqual([
      [503, 0],
      [429, 0],
      [200, 1],
    ]);
    expect(await rows("bind_history")).toBe(1);
  });

  test("a live catalog refresh is logged; cached catalog reads, presets and /instance answers store no bind", async () => {
    const { jar } = await signIn();
    await gw("GET", "/api/catalog", { jar });
    await gw("GET", "/api/presets", { jar });
    await gw("GET", "/api/catalog?force_refresh=true", { jar });
    await gw("POST", "/api/instance", { jar, body: BODY });
    await activityIdle();
    const log = await json<{ requests: { method: string; path: string; cost: number }[] }>(await gw("GET", "/api/history/requests", { jar }));
    expect(log.requests.map((r) => `${r.method} ${r.path} ${r.cost}`)).toEqual(["POST /instance 1", "GET /catalog 5"]);
    expect(await rows("bind_history")).toBe(0);
  });

  test("bindSummary copes with an unexpected answer", () => {
    expect(bindSummary(null)).toMatchObject({ feasibility: null, solutions: 0, candidates: 0, winners: [] });
  });
});

describe("reading", () => {
  test("daily totals: 30 UTC days, oldest first, split by key and browser", async () => {
    const { jar } = await signIn();
    const k = await createKey(jar);
    clock = new Date("2026-10-27T10:00:00Z");
    await select({ jar });
    clock = new Date("2026-10-28T12:00:00Z");
    await select({ jar });
    await select({ headers: { "x-api-key": k.key } });
    await select({ headers: { "x-api-key": k.key } });
    const { days } = await json<{ days: { day: string; key: number; browser: number }[] }>(await gw("GET", "/api/usage/daily", { jar }));
    expect(days).toHaveLength(30);
    expect(days[0]!.day).toBe("2026-09-29");
    expect(days.at(-2)).toEqual({ day: "2026-10-27", key: 0, browser: 1, pending: 0 });
    expect(days.at(-1)).toEqual({ day: "2026-10-28", key: 2, browser: 1, pending: 0 });
  });

  test("pages of 50 with a cursor; CSV has every row, a header and a dated filename", async () => {
    build({ dailyUnits: { signed_in: 1000 } });
    const { jar, userId } = await signIn();
    const values = Array.from({ length: PAGE_SIZE + 3 }, (_, i) => sql`(${userId}, 'POST', '/select', 1, 200, ${i})`);
    await sql`INSERT INTO request_log (user_id, method, path, cost, status, duration_ms) VALUES ${sql.join(values)}`.execute(db);
    await sql`UPDATE request_log SET at = ${clock}`.execute(db);

    const first = await json<{ requests: { id: string }[]; next: string }>(await gw("GET", "/api/history/requests", { jar }));
    expect(first.requests).toHaveLength(PAGE_SIZE);
    const second = await json<{ requests: { id: string }[]; next: string | null }>(await gw("GET", `/api/history/requests?before=${first.next}`, { jar }));
    expect(second.requests).toHaveLength(3);
    expect(second.next).toBeNull();
    expect(new Set([...first.requests, ...second.requests].map((r) => r.id)).size).toBe(PAGE_SIZE + 3);

    const res = await gw("GET", "/api/history/requests?format=csv", { jar });
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="qrb-requests-2026-09-29-to-2026-10-28.csv"');
    const lines = (await res.text()).trim().split("\r\n");
    expect(lines[0]).toBe("time_utc,method,endpoint,source,api_key,units,status,duration_ms");
    expect(lines).toHaveLength(PAGE_SIZE + 4);
  });

  test("binds CSV quotes values that need it", async () => {
    const { jar } = await signIn();
    await select({ jar, body: { ...BODY, preferences: { preset: 'my, "odd" preset' } } });
    const text = await (await gw("GET", "/api/history/binds?format=csv", { jar })).text();
    const [header, row] = text.trim().split("\r\n");
    expect(header).toBe("time_utc,status,source,api_key,winners,providers,feasibility,solutions,candidates,preset,weights,shots,data,data_as_of,cache_hit,units");
    expect(row).toContain('"my, ""odd"" preset"');
    expect(row).toContain("ibm.ibm_aachen,ibm,FEASIBLE,1,2");
  });

  test("one bind with its circuit, for reopening in /bind; other accounts cannot see it", async () => {
    const a = await signIn("g1", 1);
    const b = await signIn("g2", 2);
    await select({ jar: a.jar });
    const { binds } = await json<{ binds: { id: string }[] }>(await gw("GET", "/api/history/binds", { jar: a.jar }));
    const one = await json<{ request: { circuit_qasm: string; shots: number } }>(await gw("GET", `/api/history/binds/${binds[0]!.id}`, { jar: a.jar }));
    expect(one.request).toMatchObject({ circuit_qasm: QASM, shots: 2048, force_refresh: false });
    const other = await gw("GET", `/api/history/binds/${binds[0]!.id}`, { jar: b.jar });
    expect(other.status).toBe(404);
    expect((await json<{ detail: string }>(other)).detail).toContain("no longer stored");
    expect((await json<{ binds: unknown[] }>(await gw("GET", "/api/history/binds", { jar: b.jar }))).binds).toEqual([]);
  });

  test("delete one bind, then clear the rest; never another account's", async () => {
    const a = await signIn("g1", 1);
    const b = await signIn("g2", 2);
    for (let i = 0; i < 3; i++) await select({ jar: a.jar });
    await select({ jar: b.jar });
    const { binds } = await json<{ binds: { id: string }[] }>(await gw("GET", "/api/history/binds", { jar: a.jar }));
    expect((await gw("DELETE", `/api/history/binds/${binds[0]!.id}`, { jar: b.jar })).status).toBe(404);
    expect((await gw("DELETE", `/api/history/binds/${binds[0]!.id}`, { jar: a.jar })).status).toBe(200);
    expect(await json(await gw("DELETE", "/api/history/binds", { jar: a.jar }))).toEqual({ deleted: 2 });
    expect(await rows("bind_history")).toBe(1);
  });

  test("session only: an API key, a keyless caller and a bad id get nothing", async () => {
    const { jar } = await signIn();
    const k = await createKey(jar);
    for (const path of ["/api/usage/daily", "/api/history/requests", "/api/history/binds"]) {
      expect((await gw("GET", path, { headers: { "x-api-key": k.key } })).status).toBe(401);
      expect((await gw("GET", path)).status).toBe(401);
    }
    expect((await gw("GET", "/api/history/binds/abc", { jar })).status).toBe(404);
    expect((await gw("GET", "/api/history/requests?before=1;DROP", { jar })).status).toBe(200);
  });
});

describe("retention", () => {
  test("rows older than 30 days are hidden at once and deleted by the purge", async () => {
    const { jar } = await signIn();
    clock = new Date("2026-09-20T12:00:00Z");
    await select({ jar });
    await sql`UPDATE request_log SET at = ${clock}`.execute(db);
    await sql`UPDATE bind_history SET at = ${clock}`.execute(db);
    clock = new Date("2026-10-28T12:00:00Z");
    await select({ jar });
    expect((await json<{ binds: unknown[] }>(await gw("GET", "/api/history/binds", { jar }))).binds).toHaveLength(1);
    expect((await json<{ requests: unknown[] }>(await gw("GET", "/api/history/requests", { jar }))).requests).toHaveLength(1);
    expect(await rows("bind_history")).toBe(2);
    await purgeActivity(db, clock);
    expect(await rows("bind_history")).toBe(1);
    expect(await rows("request_log")).toBe(1);
  });
});
