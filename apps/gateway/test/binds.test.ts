/**
 * Async binds: `POST /api/binds` answers 202 with an id and resolves `/select` in the background;
 * `GET /api/binds/:id` returns the status and, once done, the `/select` envelope. Accounts only,
 * charged like `/select`, refunded when the API fails, capped per account, and recovered after a
 * restart.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "kysely";
import { activityIdle } from "../src/activity";
import { createApp } from "../src/app";
import { BIND_TIMEOUT_MS, MAX_PENDING_BINDS, recoverInterruptedBinds } from "../src/binds";
import { createAuth, type GatewayAuth } from "../src/auth";
import { createTestDatabase, type Database } from "../src/db";
import { migrateUp } from "../src/db/migrator";
import { baseConfig, BEHIND_PROXY, fakeProviders, github, identities, Jar, oauth, ORIGIN, realFetch, unexpected, type App } from "./helpers/providers";

let db: Database;
let auth: GatewayAuth;
let app: App;
let clock: Date;
/** What the fake API answers to `/select`: a status and body, or a promise to hold the bind pending. */
let answer: () => Promise<Response>;
const seen: { path: string; body: unknown; user: string | null }[] = [];

const SELECT_ANSWER = {
  result: { feasibility: "FEASIBLE", solutions: [{ binding: { task: "ibm.ibm_aachen" } }], provenance: { engine_id: "minizinc-csp" } },
  candidates: [{ candidate_id: "ibm.ibm_aachen", name: "ibm_aachen", provider_id: "ibm" }],
  source: { mode: "live", as_of: "2026-10-28T11:59:00Z", cache_hit: false },
};

beforeAll(() => {
  globalThis.fetch = fakeProviders as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});
beforeEach(async () => {
  identities.clear();
  unexpected.length = 0;
  seen.length = 0;
  answer = async () => Response.json(SELECT_ANSWER);
  clock = new Date("2026-10-28T12:00:00Z");
  db = createTestDatabase();
  await migrateUp(db);
  auth = createAuth(db, baseConfig, { logLevel: "error" });
  app = createApp({
    ...BEHIND_PROXY,
    auth,
    db,
    limits: { burst: { anonymous: 1000, signed_in: 1000, api_key: 1000 }, openRoutePerIp: { limit: 1000 }, liveRefreshWeight: 5 },
    now: () => clock,
    upstreamUrl: "http://upstream.test:8000",
    secret: "s",
    fetch: async (r) => {
      seen.push({ path: new URL(r.url).pathname, body: await r.clone().json().catch(() => null), user: r.headers.get("x-qrb-user-id") });
      return answer();
    },
  });
});
afterEach(async () => {
  await activityIdle();
  expect(unexpected).toEqual([]);
  await db.destroy();
});

const BODY = { circuit_qasm: "OPENQASM 3.0; qubit[2] q; h q[0]; cx q[0], q[1];", preferences: { preset: "balanced" }, shots: 1024, force_refresh: true };

async function gw(method: string, path: string, opts: { jar?: Jar; headers?: Record<string, string>; body?: unknown } = {}) {
  const headers: Record<string, string> = { origin: ORIGIN, "x-forwarded-for": "192.0.2.1", ...opts.headers };
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
  return jar;
}

const json = async <T = any>(res: Response) => (await res.json()) as T;
const usage = async (jar: Jar) => (await json(await gw("GET", "/api/usage", { jar }))).used as number;
const submit = async (jar: Jar, body: unknown = BODY) => gw("POST", "/api/binds", { jar, body });

/** Holds every `/select` until `release` is called; each held call then gets its own answer. */
function hold() {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  answer = async () => {
    await gate;
    return Response.json(SELECT_ANSWER);
  };
  return release;
}

describe("submit and poll", () => {
  test("202 with an id and Location, pending while the API resolves, then done with the exact /select envelope", async () => {
    const jar = await signIn();
    const release = hold();

    const res = await submit(jar);
    expect(res.status).toBe(202);
    const { id, status } = await json<{ id: string; status: string }>(res);
    expect(status).toBe("pending");
    expect(res.headers.get("location")).toBe(`/api/binds/${id}`);
    expect(res.headers.get("retry-after")).toBe("2");
    expect(res.headers.get("x-quota-remaining")).not.toBeNull();

    const pending = await gw("GET", `/api/binds/${id}`, { jar });
    expect(pending.status).toBe(200);
    expect(pending.headers.get("retry-after")).toBe("2");
    expect(await json(pending)).toEqual({ id, status: "pending", submitted_at: "2026-10-28T12:00:00.000Z", finished_at: null });

    release();
    await activityIdle();
    const done = await json(await gw("GET", `/api/binds/${id}`, { jar }));
    expect(done).toEqual({ id, status: "done", submitted_at: "2026-10-28T12:00:00.000Z", finished_at: "2026-10-28T12:00:00.000Z", result: SELECT_ANSWER });

    // The API got the body as sent, for this user.
    expect(seen).toEqual([{ path: "/select", body: BODY, user: expect.any(String) }]);
  });

  test("charged like /select (live refresh weight) and listed on the Account page with one request log row", async () => {
    const jar = await signIn();
    await submit(jar);
    await activityIdle();
    expect(await usage(jar)).toBe(5);

    const binds = await json(await gw("GET", "/api/history/binds", { jar }));
    expect(binds.binds).toHaveLength(1);
    expect(binds.binds[0]).toMatchObject({ status: "done", cost: 5, error: null, summary: { winners: [{ id: "ibm.ibm_aachen" }] } });
    const log = await json(await gw("GET", "/api/history/requests", { jar }));
    expect(log.requests).toEqual([expect.objectContaining({ method: "POST", path: "/binds", status: 200, cost: 5 })]);
  });

  test("a pending bind's units count in the day's figures, so key plus browser equals the quota counter", async () => {
    const jar = await signIn();
    const release = hold();
    await submit(jar);
    const today = async () => (await json(await gw("GET", "/api/usage/daily", { jar }))).days.at(-1);
    expect(await today()).toEqual({ day: "2026-10-28", key: 0, browser: 5, pending: 5 });
    expect(await usage(jar)).toBe(5);
    release();
    await activityIdle();
    expect(await today()).toEqual({ day: "2026-10-28", key: 0, browser: 5, pending: 0 });
  });

  test("an API key can submit and poll", async () => {
    const jar = await signIn();
    const { key } = await json(await gw("POST", "/api/keys", { jar, body: {} }));
    const res = await gw("POST", "/api/binds", { headers: { "x-api-key": key }, body: BODY });
    expect(res.status).toBe(202);
    const { id } = await json(res);
    await activityIdle();
    expect((await json(await gw("GET", `/api/binds/${id}`, { headers: { "x-api-key": key } }))).status).toBe("done");
  });
});

describe("failures", () => {
  test("an API 5xx fails the bind and refunds its units", async () => {
    const jar = await signIn();
    answer = async () => Response.json({ detail: "IBM did not answer" }, { status: 502 });
    const { id } = await json(await submit(jar));
    await activityIdle();
    expect(await json(await gw("GET", `/api/binds/${id}`, { jar }))).toMatchObject({ status: "failed", error: "IBM did not answer" });
    expect(await usage(jar)).toBe(0);
    const log = await json(await gw("GET", "/api/history/requests", { jar }));
    expect(log.requests).toEqual([expect.objectContaining({ path: "/binds", status: 502, cost: 0 })]);
  });

  test("an unreachable API fails the bind and refunds", async () => {
    const jar = await signIn();
    answer = async () => {
      throw new TypeError("connection refused");
    };
    const { id } = await json(await submit(jar));
    await activityIdle();
    expect(await json(await gw("GET", `/api/binds/${id}`, { jar }))).toMatchObject({ status: "failed", error: "Upstream API unavailable" });
    expect(await usage(jar)).toBe(0);
  });

  test("an API 4xx fails the bind and keeps the charge, as on /select", async () => {
    const jar = await signIn();
    answer = async () => Response.json({ detail: "QASM does not parse" }, { status: 422 });
    const { id } = await json(await submit(jar));
    await activityIdle();
    expect(await json(await gw("GET", `/api/binds/${id}`, { jar }))).toMatchObject({ status: "failed", error: "QASM does not parse" });
    expect(await usage(jar)).toBe(5);
  });

  test("a body that is not a JSON object is 422 and costs nothing", async () => {
    const jar = await signIn();
    expect((await submit(jar, [1, 2])).status).toBe(422);
    expect(await usage(jar)).toBe(0);
    expect(seen).toEqual([]);
  });
});

describe("access", () => {
  test("keyless callers get 401 and are pointed to /select; nothing is charged or forwarded", async () => {
    const res = await gw("POST", "/api/binds", { body: BODY });
    expect(res.status).toBe(401);
    expect((await json(res)).detail).toContain("/api/select");
    expect(seen).toEqual([]);
  });

  test("another account's bind, an unknown id and a malformed id are 404", async () => {
    const a = await signIn("g1", 1);
    const b = await signIn("g2", 2);
    const { id } = await json(await submit(a));
    await activityIdle();
    expect((await gw("GET", `/api/binds/${id}`, { jar: b })).status).toBe(404);
    expect((await gw("GET", `/api/binds/${crypto.randomUUID()}`, { jar: a })).status).toBe(404);
    expect((await gw("GET", "/api/binds/1", { jar: a })).status).toBe(404);
  });

  test(`at most ${MAX_PENDING_BINDS} pending binds per account; the next is 429 and costs nothing`, async () => {
    const jar = await signIn();
    const release = hold();
    for (let i = 0; i < MAX_PENDING_BINDS; i++) expect((await submit(jar)).status).toBe(202);
    const over = await submit(jar);
    expect(over.status).toBe(429);
    expect(over.headers.get("retry-after")).toBe("2");
    expect(await usage(jar)).toBe(5 * MAX_PENDING_BINDS);
    release();
    await activityIdle();
    expect((await submit(jar)).status).toBe(202);
  });
});

describe("restart recovery", () => {
  test("a bind left pending past the timeout is failed and refunded; a recent one is left alone", async () => {
    const jar = await signIn();
    const release = hold(); // not answered yet: as if the gateway died mid-bind
    const { id: old } = await json(await submit(jar));
    clock = new Date(clock.getTime() + BIND_TIMEOUT_MS + 1000);
    const { id: recent } = await json(await submit(jar));
    expect(await usage(jar)).toBe(10);

    expect(await recoverInterruptedBinds(db, clock)).toBe(1);
    expect(await json(await gw("GET", `/api/binds/${old}`, { jar }))).toMatchObject({ status: "failed", error: expect.stringContaining("Interrupted") });
    expect((await json(await gw("GET", `/api/binds/${recent}`, { jar }))).status).toBe("pending");
    expect(await usage(jar)).toBe(5);
    const { rows } = await sql<{ cost: number; status: number }>`SELECT cost, status FROM request_log WHERE path = '/binds'`.execute(db);
    expect(rows).toEqual([{ cost: 0, status: 504 }]);


    // A late answer does not undo the recovery (no second refund, no second log row).
    release();
    await activityIdle();
    expect((await json(await gw("GET", `/api/binds/${old}`, { jar }))).status).toBe("failed");
    expect((await json(await gw("GET", `/api/binds/${recent}`, { jar }))).status).toBe("done");
    expect(await usage(jar)).toBe(5);
  });
});
