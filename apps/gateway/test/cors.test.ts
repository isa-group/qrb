/**
 * Task 2.6: credentialed CORS (http-api "Cross-origin access"): only origins
 * in WEB_ORIGINS, exact match, preflight answered before auth and limits.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "kysely";
import { acceptCaptcha } from "./helpers/captcha";
import { createApp } from "../src/app";
import { createAuth, type GatewayAuth } from "../src/auth";
import { webOriginsFromEnv } from "../src/cors";
import { createTestDatabase, type Database } from "../src/db";
import { migrateUp } from "../src/db/migrator";
import { baseConfig, fakeProviders, github, identities, Jar, oauth, ORIGIN, realFetch, signedInUserId, unexpected, type App } from "./helpers/providers";

const DEV = "http://localhost:3000";
const OTHER = "https://evil.example";

let db: Database;
let auth: GatewayAuth;
let app: App;
let upstream: Request[];
let savedWebOrigins: string | undefined;

function build(webOrigins?: string[]) {
  app = createApp({
    captcha: acceptCaptcha,
    auth,
    db,
    webOrigins,
    clientAddress: () => "127.0.0.1",
    upstreamUrl: "http://upstream.test:8000",
    secret: "s",
    fetch: async (r) => {
      upstream.push(r);
      return Response.json({ ok: true });
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
  savedWebOrigins = process.env.WEB_ORIGINS;
  delete process.env.WEB_ORIGINS;
  identities.clear();
  unexpected.length = 0;
  upstream = [];
  db = createTestDatabase();
  await migrateUp(db);
  auth = createAuth(db, baseConfig, { logLevel: "error" });
  build();
});
afterEach(async () => {
  if (savedWebOrigins === undefined) delete process.env.WEB_ORIGINS;
  else process.env.WEB_ORIGINS = savedWebOrigins;
  expect(unexpected).toEqual([]);
  await db.destroy();
});

async function req(method: string, path: string, opts: { origin?: string; jar?: Jar; headers?: Record<string, string>; body?: unknown } = {}) {
  const headers: Record<string, string> = { "x-forwarded-for": "192.0.2.1", ...opts.headers };
  if (opts.origin) headers.origin = opts.origin;
  const cookie = opts.jar?.header();
  if (cookie) headers.cookie = cookie;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  return app.request(`${ORIGIN}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
}
const preflight = (path: string, origin: string, method = "POST") =>
  req("OPTIONS", path, { origin, headers: { "access-control-request-method": method, "access-control-request-headers": "content-type,x-api-key,x-captcha-token" } });

const cors = (res: Response) => ({
  origin: res.headers.get("access-control-allow-origin"),
  credentials: res.headers.get("access-control-allow-credentials"),
  expose: res.headers.get("access-control-expose-headers"),
});

async function signIn(): Promise<Jar> {
  github("g1", 1, "u1@example.org", true);
  const jar = new Jar();
  await oauth(app, jar, "github", "g1");
  expect(await signedInUserId(app, jar)).toBeTruthy();
  return jar;
}

describe("WEB_ORIGINS parsing", () => {
  test("defaults, list, normalisation, production", () => {
    expect(webOriginsFromEnv({})).toEqual(["http://localhost:3000", "http://localhost:3002"]);
    expect(webOriginsFromEnv({ WEB_ORIGINS: " " })).toEqual(["http://localhost:3000", "http://localhost:3002"]);
    expect(webOriginsFromEnv({ WEB_ORIGINS: "https://a.example, http://b.example:8080/" })).toEqual(["https://a.example", "http://b.example:8080"]);
    expect(webOriginsFromEnv({ NODE_ENV: "production", WEB_ORIGINS: "https://a.example" })).toEqual([]);
  });
});

describe("Cross-origin access", () => {
  test("default origin with its session cookie: allowed and the cookie is accepted", async () => {
    const jar = await signIn();
    for (const path of ["/api/auth/get-session", "/api/usage"]) {
      const res = await req("GET", path, { origin: DEV, jar });
      expect(res.status).toBe(200);
      expect(cors(res)).toMatchObject({ origin: DEV, credentials: "true" });
      expect(res.headers.get("vary")).toContain("Origin");
    }
    const session = (await (await req("GET", "/api/auth/get-session", { origin: DEV, jar })).json()) as { user: { email: string } };
    expect(session.user.email).toBe("u1@example.org"); // the cookie was accepted
    const usage = (await (await req("GET", "/api/usage", { origin: DEV, jar })).json()) as { tier: string };
    expect(usage.tier).toBe("signed_in");
  });

  test("the second default origin and a WEB_ORIGINS override", async () => {
    expect(cors(await req("GET", "/api/health", { origin: "http://localhost:3002" })).origin).toBe("http://localhost:3002");
    build(["https://app.example"]);
    expect(cors(await req("GET", "/api/health", { origin: "https://app.example" })).origin).toBe("https://app.example");
    expect(cors(await req("GET", "/api/health", { origin: DEV })).origin).toBeNull(); // no longer listed
  });

  test("WEB_ORIGINS from the environment is read at creation", async () => {
    process.env.WEB_ORIGINS = "https://env.example";
    build();
    expect(cors(await req("GET", "/api/health", { origin: "https://env.example" })).origin).toBe("https://env.example");
    expect(cors(await req("GET", "/api/health", { origin: DEV })).origin).toBeNull();
  });

  test("unlisted origin: no credentialed access (no CORS headers), for GET, POST /api/select and preflight", async () => {
    const jar = await signIn();
    const get = await req("GET", "/api/usage", { origin: OTHER, jar });
    const post = await req("POST", "/api/select", { origin: OTHER, jar, body: { circuit_qasm: "OPENQASM 3.0; qubit q;", force_refresh: false }, headers: { "x-captcha-token": "t" } });
    const pre = await preflight("/api/select", OTHER);
    for (const res of [get, post, pre]) {
      const h = res.headers;
      expect([...h.keys()].filter((k) => k.startsWith("access-control-"))).toEqual([]);
    }
    expect(pre.status).not.toBe(204);
  });

  test("near-miss origins do not match (exact matching)", async () => {
    for (const o of ["http://localhost:3000/", "http://localhost:30000", "https://localhost:3000", "http://localhost:3000.evil.example", "null"]) {
      expect(cors(await req("GET", "/api/health", { origin: o })).origin).toBeNull();
    }
  });

  test("no Origin header: no CORS headers", async () => {
    expect(cors(await req("GET", "/api/health"))).toEqual({ origin: null, credentials: null, expose: null });
  });

  test("production: CORS is off even when WEB_ORIGINS is set", async () => {
    build(webOriginsFromEnv({ NODE_ENV: "production", WEB_ORIGINS: DEV }));
    const res = await req("GET", "/api/health", { origin: DEV });
    expect(cors(res)).toEqual({ origin: null, credentials: null, expose: null });
  });
});

describe("exposed headers", () => {
  test("quota and Retry-After headers are exposed on counted, rejected and plain responses", async () => {
    const ok = await req("POST", "/api/select", { origin: DEV, headers: { "x-captcha-token": "t" }, body: { circuit_qasm: "OPENQASM 3.0; qubit q;", force_refresh: false } });
    // Anonymous without a session cookie gets an identity and is counted.
    expect(ok.status).toBe(200);
    expect(ok.headers.get("x-quota-remaining")).not.toBeNull();
    const expose = cors(ok).expose!.toLowerCase().split(",");
    for (const h of ["x-quota-limit", "x-quota-remaining", "x-quota-reset", "retry-after"]) expect(expose).toContain(h);
    expect(cors(ok)).toMatchObject({ origin: DEV, credentials: "true" });

    const rejected = await req("POST", "/api/select", { origin: DEV, body: { circuit_qasm: "x" } }); // no CAPTCHA token: 403 policy rejection
    expect(rejected.status).toBeGreaterThanOrEqual(400);
    expect(cors(rejected)).toMatchObject({ origin: DEV, credentials: "true" });
  });
});

describe("preflight", () => {
  test("allowed origin: 204 with origin, credentials, methods, headers; for every API area", async () => {
    for (const path of ["/api/select", "/api/instance", "/api/catalog", "/api/auth/sign-in/social", "/api/auth/get-session", "/api/keys", "/api/keys/abc", "/api/usage", "/api/health"]) {
      const res = await preflight(path, DEV, path === "/api/keys/abc" ? "DELETE" : "POST");
      expect(res.status).toBe(204);
      expect(cors(res)).toMatchObject({ origin: DEV, credentials: "true" });
      const allowHeaders = res.headers.get("access-control-allow-headers")!.toLowerCase();
      for (const h of ["content-type", "x-api-key", "x-captcha-token"]) expect(allowHeaders).toContain(h);
      const methods = res.headers.get("access-control-allow-methods")!;
      for (const m of ["GET", "POST", "DELETE"]) expect(methods).toContain(m);
      expect(res.headers.get("vary")).toContain("Origin");
      expect(await res.text()).toBe("");
    }
  });

  test("unlisted origin: not granted", async () => {
    const res = await preflight("/api/auth/sign-in/social", OTHER);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    expect(res.status).not.toBe(204);
  });

  test("consumes nothing: no quota, burst, identity or upstream call", async () => {
    for (let i = 0; i < 80; i++) {
      expect((await preflight(i % 2 ? "/api/select" : "/api/health", DEV)).status).toBe(204);
    }
    const n = async (table: string) => (await sql<{ n: number }>`SELECT count(*)::int AS n FROM ${sql.table(table)}`.execute(db)).rows[0]!.n;
    expect(await n("burst_bucket")).toBe(0);
    expect(await n("quota_user_daily")).toBe(0);
    expect(await n("quota_ip_daily")).toBe(0);
    expect(await n("user")).toBe(0);
    expect(upstream).toEqual([]);
    // The open-route limit (60/min) was not touched either: the next real call passes.
    expect((await req("GET", "/api/health", { origin: DEV })).status).toBe(200);
  });
});
