/**
 * CAPTCHA on anonymous resolves (task 4.4): Turnstile verification with a
 * stubbed verifier (no network), who skips it, status codes, and the
 * Turnstile client itself against a fake siteverify.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "kysely";
import { createApp } from "../src/app";
import { createAuth } from "../src/auth";
import { CaptchaUnavailableError, captchaFromEnv, SITEVERIFY_URL, TURNSTILE_TEST_SECRET, turnstileVerifier } from "../src/captcha";
import { createTestDatabase, type Database } from "../src/db";
import { migrateUp } from "../src/db/migrator";
import { stubCaptcha, type StubCaptcha } from "./helpers/captcha";
import { baseConfig, BEHIND_PROXY, fakeProviders, github, identities, Jar, oauth, ORIGIN, realFetch, unexpected, type App } from "./helpers/providers";

let db: Database;
let app: App;
let captcha: StubCaptcha;
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
  captcha = stubCaptcha();
  db = createTestDatabase();
  await migrateUp(db);
  app = createApp({
    ...BEHIND_PROXY,
    captcha,
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

const BODY = { circuit_qasm: "OPENQASM 3.0; qubit[1] q; h q[0];", force_refresh: false };

async function gw(path: string, opts: { jar?: Jar; headers?: Record<string, string>; method?: string } = {}) {
  const headers: Record<string, string> = { origin: ORIGIN, "x-forwarded-for": "192.0.2.7", "content-type": "application/json", ...opts.headers };
  const cookie = opts.jar?.header();
  if (cookie) headers.cookie = cookie;
  const res = await app.request(`${ORIGIN}${path}`, { method: opts.method ?? "POST", headers, body: JSON.stringify(BODY) });
  opts.jar?.store(res);
  return res;
}
const count = async (table: string) => (await sql<{ n: number }>`SELECT count(*)::int AS n FROM ${sql.table(table)}`.execute(db)).rows[0]!.n;
const unitsUsed = async () => (await sql<{ n: number }>`SELECT coalesce(sum(units_used), 0)::int AS n FROM quota_user_daily`.execute(db)).rows[0]!.n;

describe("CAPTCHA for anonymous resolves", () => {
  test("valid token: forwarded, identity created, counted, verifier got token and resolved client IP", async () => {
    const jar = new Jar();
    const res = await gw("/api/select", { jar, headers: { "x-captcha-token": "good" } });
    expect(res.status).toBe(200);
    expect(captcha.calls).toEqual([{ token: "good", remoteIp: "192.0.2.7" }]);
    expect(await count("user")).toBe(1);
    expect(await unitsUsed()).toBe(1);
    expect(upstream).toHaveLength(1);
  });

  test("remoteip is the resolved client IP (right-most untrusted X-Forwarded-For entry), not a client-supplied one", async () => {
    await gw("/api/select", { headers: { "x-captcha-token": "t", "x-forwarded-for": "198.51.100.9, 192.0.2.50" } });
    expect(captcha.calls[0]!.remoteIp).toBe("192.0.2.50");
  });

  test("invalid token on a new caller -> 403, no identity, nothing counted, not forwarded", async () => {
    const res = await gw("/api/select", { headers: { "x-captcha-token": "bad" } });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ detail: "CAPTCHA verification failed" });
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(await count("user")).toBe(0);
    expect(await unitsUsed()).toBe(0);
    expect(upstream).toHaveLength(0);
  });

  test("existing anonymous session: a missing, blank or invalid token -> 403 and nothing counted; a fresh valid token passes", async () => {
    const jar = new Jar();
    expect((await gw("/api/select", { jar, headers: { "x-captcha-token": "t1" } })).status).toBe(200);
    expect(await unitsUsed()).toBe(1);
    captcha.calls.length = 0;
    for (const headers of [{} as Record<string, string>, { "x-captcha-token": "   " }, { "x-captcha-token": "bad" }]) {
      const res = await gw("/api/instance", { jar, headers });
      expect([JSON.stringify(headers), res.status]).toEqual([JSON.stringify(headers), 403]);
      expect(await res.json()).toEqual({ detail: "CAPTCHA verification failed" });
    }
    expect(await unitsUsed()).toBe(1);
    expect(upstream).toHaveLength(1);
    expect(await count("user")).toBe(1);
    expect((await gw("/api/instance", { jar, headers: { "x-captcha-token": "t2" } })).status).toBe(200);
    expect(await unitsUsed()).toBe(2);
  });

  test("no session, no key, no token at all stays 401 and the verifier is not called", async () => {
    expect((await gw("/api/select")).status).toBe(401);
    expect(captcha.calls).toEqual([]);
  });

  test("each request is verified: verdicts are not cached across requests", async () => {
    const jar = new Jar();
    await gw("/api/select", { jar, headers: { "x-captcha-token": "same" } });
    await gw("/api/select", { jar, headers: { "x-captcha-token": "same" } });
    expect(captcha.calls).toHaveLength(2);
  });

  test("signed-in sessions skip verification, with or without a token", async () => {
    github("g1", 1, "u1@example.org", true);
    const jar = new Jar();
    await oauth(app, jar, "github", "g1");
    expect((await gw("/api/select", { jar })).status).toBe(200);
    expect((await gw("/api/select", { jar, headers: { "x-captcha-token": "bad" } })).status).toBe(200);
    expect(captcha.calls).toEqual([]);
  });

  test("API keys skip verification", async () => {
    github("g1", 1, "u1@example.org", true);
    const jar = new Jar();
    await oauth(app, jar, "github", "g1");
    const created = await app.request(`${ORIGIN}/api/keys`, {
      method: "POST",
      headers: { origin: ORIGIN, cookie: jar.header(), "content-type": "application/json" },
      body: JSON.stringify({ name: "k" }),
    });
    const { key } = (await created.json()) as { key: string };
    const res = await gw("/api/select", { headers: { "x-api-key": key } });
    expect(res.status).toBe(200);
    expect(captcha.calls).toEqual([]);
  });

  test("verifier outage -> 503, fail closed: no identity, nothing counted, not forwarded; signed-in users unaffected", async () => {
    captcha.mode = "outage";
    const res = await gw("/api/select", { headers: { "x-captcha-token": "t" } });
    expect(res.status).toBe(503);
    expect(typeof ((await res.json()) as { detail: string }).detail).toBe("string");
    expect(await count("user")).toBe(0);
    expect(await unitsUsed()).toBe(0);
    expect(upstream).toHaveLength(0);
    github("g1", 1, "u1@example.org", true);
    const jar = new Jar();
    await oauth(app, jar, "github", "g1");
    expect((await gw("/api/select", { jar })).status).toBe(200);
  });

  test("anonymous live refresh with a valid token is still 403 (sign-in)", async () => {
    const live = await app.request(`${ORIGIN}/api/select`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json", "x-captcha-token": "t" },
      body: JSON.stringify({ ...BODY, force_refresh: true }),
    });
    expect(live.status).toBe(403);
    expect(((await live.json()) as { detail: string }).detail).toMatch(/sign-in/i);
  });
});

describe("Turnstile verifier", () => {
  type Answer = Record<string, unknown>;
  function fake(answer: Answer | Error | number) {
    const seen: { url: string; form: URLSearchParams }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      seen.push({ url, form: new URLSearchParams(init.body as URLSearchParams) });
      if (answer instanceof Error) throw answer;
      if (typeof answer === "number") return new Response("x", { status: answer });
      return Response.json(answer);
    }) as unknown as typeof fetch;
    return { f, seen };
  }

  test("posts secret, response and remoteip to siteverify; success true passes", async () => {
    const { f, seen } = fake({ success: true, hostname: "qrb.example" });
    expect(await turnstileVerifier({ secret: "sec", fetch: f }).verify({ token: "tok", remoteIp: "203.0.113.4" })).toBe(true);
    expect(seen[0]!.url).toBe(SITEVERIFY_URL);
    expect(Object.fromEntries(seen[0]!.form)).toEqual({ secret: "sec", response: "tok", remoteip: "203.0.113.4" });
  });

  test("remoteip is omitted when unknown", async () => {
    const { f, seen } = fake({ success: true });
    await turnstileVerifier({ secret: "sec", fetch: f }).verify({ token: "tok" });
    expect(seen[0]!.form.has("remoteip")).toBe(false);
  });

  test("success false -> false; hostname and action mismatches -> false when configured", async () => {
    expect(await turnstileVerifier({ secret: "s", fetch: fake({ success: false, "error-codes": ["invalid-input-response"] }).f }).verify({ token: "t" })).toBe(false);
    const ok = { success: true, hostname: "qrb.example", action: "resolve" };
    const opts = { secret: "s", expectedHostname: "qrb.example", expectedAction: "resolve" };
    expect(await turnstileVerifier({ ...opts, fetch: fake(ok).f }).verify({ token: "t" })).toBe(true);
    expect(await turnstileVerifier({ ...opts, fetch: fake({ ...ok, hostname: "evil.example" }).f }).verify({ token: "t" })).toBe(false);
    expect(await turnstileVerifier({ ...opts, fetch: fake({ ...ok, action: "login" }).f }).verify({ token: "t" })).toBe(false);
  });

  test("network error, non-2xx and internal-error are outages (CaptchaUnavailableError)", async () => {
    for (const answer of [new Error("offline"), 500, { success: false, "error-codes": ["internal-error"] }]) {
      await expect(turnstileVerifier({ secret: "s", fetch: fake(answer).f }).verify({ token: "t" })).rejects.toBeInstanceOf(CaptchaUnavailableError);
    }
  });

  test("captchaFromEnv: required in production, test secret otherwise", () => {
    expect(() => captchaFromEnv({ NODE_ENV: "production" })).toThrow(/TURNSTILE_SECRET_KEY/);
    expect(() => captchaFromEnv({ NODE_ENV: "production", TURNSTILE_SECRET_KEY: "x" })).not.toThrow();
    expect(() => captchaFromEnv({})).not.toThrow();
    expect(TURNSTILE_TEST_SECRET).toBe("1x0000000000000000000000000000000AA");
  });
});
