/**
 * Anonymous identities: created on the first resolve request that needs one,
 * never on open routes or API-key requests, and linked to the account on
 * sign-in so that today's units carry over.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { sql } from "kysely";
import { acceptCaptcha } from "./helpers/captcha";
import { createApp } from "../src/app";
import { createAuth, ensureIdentity, sessionUser, type GatewayAuth } from "../src/auth";
import { isPlaceholderEmail } from "../src/auth/email-policy";
import { createTestDatabase, type Database } from "../src/db";
import { moveDailyUnits, tryConsumeDailyUnits, utcDay } from "../src/db/counters";
import { migrateUp } from "../src/db/migrator";
import type { GatewayEnv } from "../src/forward";
import {
  accountsOf,
  baseConfig,
  call,
  fakeProviders,
  github,
  identities,
  Jar,
  oauth,
  ORIGIN,
  realFetch,
  session,
  signedInUserId,
  unexpected,
  type App,
  BEHIND_PROXY,
} from "./helpers/providers";

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
    captcha: acceptCaptcha,
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

// Anonymous identities need a CAPTCHA token (header; task 4.4 verifies it) and, cached-only, an explicit force_refresh: false.
const SELECT_BODY = { circuit_qasm: "OPENQASM 3.0; qubit[2] q; h q[0]; cx q[0], q[1];", force_refresh: false };

/** A gateway (non-auth) request with the jar's cookies; stores Set-Cookie. */
async function gw(
  jar: Jar,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  opts: { ip?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers: Record<string, string> = { origin: ORIGIN, "x-forwarded-for": opts.ip ?? "192.0.2.1", "x-captcha-token": "t", ...opts.headers };
  const cookie = jar.header();
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await app.request(`${ORIGIN}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  jar.store(res);
  return res;
}

const users = async () =>
  (
    await sql<{ id: string; isAnonymous: boolean | null; email: string }>`
      SELECT id, "isAnonymous", email FROM "user" ORDER BY "createdAt"`.execute(db)
  ).rows;

const unitsToday = async (userId: string) =>
  (
    await sql<{ units_used: number }>`
      SELECT units_used FROM quota_user_daily WHERE user_id = ${userId} AND day = ${utcDay()}::date`.execute(db)
  ).rows[0]?.units_used ?? 0;

const consume = (userId: string, units: number, day = utcDay()) =>
  tryConsumeDailyUnits(db, { table: "quota_user_daily", key: userId, day, units, quota: 1000 });

const lastUpstreamUser = () => upstreamSeen.at(-1)!.headers.get("x-qrb-user-id");

// --- Anonymous identity ----------------------------------------------------------

describe("Anonymous identity", () => {
  test("first resolve with no session creates an anonymous user and sets the session cookie; the cookie reuses it", async () => {
    const jar = new Jar();
    const first = await gw(jar, "POST", "/api/select", SELECT_BODY);
    expect(first.status).toBe(200);

    const all = await users();
    expect(all).toHaveLength(1);
    expect(all[0]!.isAnonymous).toBe(true);
    const anonId = all[0]!.id;
    expect(lastUpstreamUser()).toBe(anonId);

    // Same cookie attributes as a signed-in session (task 3.1).
    const cookieLine = first.headers.getSetCookie().find((l) => l.startsWith("better-auth.session_token="));
    expect(cookieLine).toBeDefined();
    expect(cookieLine).toMatch(/;\s*HttpOnly/i);
    expect(cookieLine).toMatch(/;\s*SameSite=Lax/i);
    expect(cookieLine).toMatch(/;\s*Path=\//i);
    // The upstream's response body is passed through untouched.
    expect(await first.json()).toEqual({ ok: true });

    const second = await gw(jar, "POST", "/api/instance", SELECT_BODY);
    expect(second.status).toBe(200);
    expect(second.headers.getSetCookie()).toEqual([]);
    expect(lastUpstreamUser()).toBe(anonId);
    expect(await users()).toHaveLength(1);

    // Better Auth sees it as an anonymous session too.
    const s = (await (await call(app, jar, "GET", "/get-session")).json()) as { user: { id: string; isAnonymous: boolean } };
    expect(s.user).toMatchObject({ id: anonId, isAnonymous: true });
  });

  test("the cookie is set even when the upstream fails, so a retry keeps the identity", async () => {
    app = createApp({ ...BEHIND_PROXY,
    captcha: acceptCaptcha, auth, upstreamUrl: "http://upstream.test:8000", secret: "s", fetch: async () => new Response("boom", { status: 503 }) });
    const jar = new Jar();
    const res = await gw(jar, "POST", "/api/select", SELECT_BODY);
    expect(res.status).toBe(503);
    expect(jar.cookies.has("better-auth.session_token")).toBe(true);
    await gw(jar, "POST", "/api/select", SELECT_BODY);
    expect(await users()).toHaveLength(1);
  });

  test("open routes do not create identities or set cookies", async () => {
    for (const path of ["/api/catalog", "/api/catalog/abc", "/api/engines", "/api/presets"]) {
      const res = await gw(new Jar(), "GET", path);
      expect([path, res.status]).toEqual([path, 200]);
      expect(res.headers.getSetCookie()).toEqual([]);
      expect(lastUpstreamUser()).toBeNull();
    }
    expect(await users()).toEqual([]);
  });

  test("requests with an API key never get an anonymous identity", async () => {
    const res = await gw(new Jar(), "POST", "/api/select", SELECT_BODY, { headers: { "x-api-key": "qrb_something" } });
    // An unknown key is a 401 (see api-keys.test.ts), never an anonymous identity.
    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(upstreamSeen).toEqual([]);
    expect(await users()).toEqual([]);
  });

  test("requests rejected by input checks create no identity", async () => {
    const res = await gw(new Jar(), "POST", "/api/select", { ...SELECT_BODY, snapshot_path: "/etc/passwd" });
    expect(res.status).toBe(422);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(upstreamSeen).toEqual([]);
    expect(await users()).toEqual([]);
  });

  test("many first-time requests from one IP each get an identity (not subject to the sign-in rate limit)", async () => {
    // Better Auth's sign-in limit is 3 per 10 s per IP (see auth.test.ts).
    const ip = "203.0.113.50";
    const ids = new Set<string>();
    for (let i = 0; i < 6; i++) {
      const res = await gw(new Jar(), "POST", "/api/select", SELECT_BODY, { ip });
      expect(res.status).toBe(200);
      ids.add(lastUpstreamUser()!);
    }
    expect(ids.size).toBe(6);
    expect((await users()).every((u) => u.isAnonymous)).toBe(true);
  });

  test("the public anonymous sign-in route is disabled", async () => {
    const res = await call(app, new Jar(), "POST", "/sign-in/anonymous", {});
    expect(res.status).toBe(404);
    expect(await users()).toEqual([]);
  });

  test("an invalid session cookie is replaced by a new anonymous identity", async () => {
    const jar = new Jar();
    jar.cookies.set("better-auth.session_token", "forged.value");
    const res = await gw(jar, "POST", "/api/select", SELECT_BODY);
    expect(res.status).toBe(200);
    expect(await users()).toHaveLength(1);
    expect(lastUpstreamUser()).toBe((await users())[0]!.id);
  });

  test("isAnonymous is exposed for the limits: true for anonymous, false when signed in, unset without identity", async () => {
    const getAuth = async () => auth;
    const probe = new Hono<GatewayEnv>();
    probe.post("/probe", sessionUser(getAuth), ensureIdentity(getAuth), (c) =>
      c.json({ userId: c.get("userId") ?? null, isAnonymous: c.get("isAnonymous") ?? null }),
    );
    const ask = async (jar: Jar, headers: Record<string, string> = {}) => {
      const res = await probe.request(`${ORIGIN}/probe`, { method: "POST", headers: { cookie: jar.header(), ...headers } });
      jar.store(res);
      return (await res.json()) as { userId: string | null; isAnonymous: boolean | null };
    };

    const anon = new Jar();
    const first = await ask(anon);
    expect(first.isAnonymous).toBe(true);
    expect(await ask(anon)).toEqual(first); // from the session cookie this time

    github("g1", 1001, "ana@example.org", true);
    const signedIn = new Jar();
    await oauth(app, signedIn, "github", "g1");
    expect(await ask(signedIn)).toEqual({ userId: await signedInUserId(app, signedIn), isAnonymous: false });

    expect(await ask(new Jar(), { "x-api-key": "k" })).toEqual({ userId: null, isAnonymous: null });
  });
});

// --- Linking anonymous use to an account --------------------------------------------

describe("Linking anonymous use to an account", () => {
  async function anonymousWithUnits(units: number): Promise<{ jar: Jar; anonId: string }> {
    const jar = new Jar();
    await gw(jar, "POST", "/api/select", SELECT_BODY);
    const anonId = lastUpstreamUser()!;
    // The identity-creating resolve is charged by the quota engine (4.1); reset
    // so the test controls the exact units carried over.
    await sql`DELETE FROM quota_user_daily WHERE user_id = ${anonId}`.execute(db);
    if (units > 0) await consume(anonId, units);
    return { jar, anonId };
  }

  test("sign up after anonymous use: the new account starts the day with the anonymous units; the anonymous user is removed", async () => {
    const { jar, anonId } = await anonymousWithUnits(4);
    await consume(anonId, 2, "2020-01-01"); // an older day is not carried over

    github("g1", 2001, "new@example.org", true);
    const { location } = await oauth(app, jar, "github", "g1");
    expect(location).toBe("/done");

    const accountId = await signedInUserId(app, jar);
    expect(accountId).not.toBe(anonId);
    expect(await unitsToday(accountId)).toBe(4);

    const remaining = await users();
    expect(remaining.map((u) => u.id)).toEqual([accountId]);
    expect(remaining[0]!.isAnonymous).toBeFalsy();
    const { rows } = await sql<{ n: number }>`SELECT count(*)::int AS n FROM quota_user_daily WHERE user_id = ${anonId}`.execute(db);
    expect(rows[0]!.n).toBe(0);
    const { rows: old } = await sql<{ n: number }>`SELECT count(*)::int AS n FROM quota_user_daily WHERE day <> ${utcDay()}::date`.execute(db);
    expect(old[0]!.n).toBe(0);

    // Later resolves are counted against the account.
    await gw(jar, "POST", "/api/select", SELECT_BODY);
    expect(lastUpstreamUser()).toBe(accountId);
    expect(await users()).toHaveLength(1);
  });

  test("sign in to an existing account that already has units today: the units are summed", async () => {
    github("g1", 2002, "old@example.org", true);
    const elsewhere = new Jar();
    await oauth(app, elsewhere, "github", "g1");
    const accountId = await signedInUserId(app, elsewhere);
    await consume(accountId, 3);

    const { jar, anonId } = await anonymousWithUnits(4);
    await oauth(app, jar, "github", "g1");
    expect(await signedInUserId(app, jar)).toBe(accountId);
    expect(await unitsToday(accountId)).toBe(7);
    expect((await users()).map((u) => u.id)).toEqual([accountId]);
    expect(await unitsToday(anonId)).toBe(0);
  });

  test("an anonymous user with no units today links without creating a counter row", async () => {
    const { jar } = await anonymousWithUnits(0);
    github("g1", 2003, "zero@example.org", true);
    await oauth(app, jar, "github", "g1");
    const accountId = await signedInUserId(app, jar);
    expect(await unitsToday(accountId)).toBe(0);
    const { rows } = await sql<{ n: number }>`SELECT count(*)::int AS n FROM quota_user_daily`.execute(db);
    expect(rows[0]!.n).toBe(0);
    expect(await users()).toHaveLength(1);
  });

  test("the email policy still applies from an anonymous session: an unverified email does not merge", async () => {
    github("victim", 2101, "victim@example.org", true);
    github("attacker", 2102, "victim@example.org", false);
    const victim = new Jar();
    await oauth(app, victim, "github", "victim");
    const victimId = await signedInUserId(app, victim);

    const { jar, anonId } = await anonymousWithUnits(4);
    const { location } = await oauth(app, jar, "github", "attacker");
    expect(location).toBe("/done");
    const s = await session(app, jar);
    expect(s!.user.id).not.toBe(victimId);
    expect(s!.user.id).not.toBe(anonId);
    expect(isPlaceholderEmail(s!.user.email)).toBe(true);
    expect(s!.user.emailVerified).toBe(false);
    expect(await accountsOf(db, victimId)).toEqual([{ providerId: "github", accountId: "2101" }]);

    // Units went to the attacker's own new account, not the victim's.
    expect(await unitsToday(s!.user.id)).toBe(4);
    expect(await unitsToday(victimId)).toBe(0);
    expect((await users()).map((u) => u.id).sort()).toEqual([victimId, s!.user.id].sort());
  });

  test("a verified email matching an existing account merges from an anonymous session, and the units follow", async () => {
    github("g1", 2201, "same@example.org", true);
    const first = new Jar();
    await oauth(app, first, "github", "g1");
    const accountId = await signedInUserId(app, first);

    const { jar } = await anonymousWithUnits(2);
    await oauth(app, jar, "github", "g1");
    expect(await signedInUserId(app, jar)).toBe(accountId);
    expect(await unitsToday(accountId)).toBe(2);
  });
});

describe("moveDailyUnits", () => {
  test("moves only the given day, sums into an existing row, and removes all of the source's rows", async () => {
    const day = "2026-10-28";
    await consume("anon", 4, day);
    await consume("anon", 9, "2026-10-27");
    await consume("acct", 5, day);
    expect(await moveDailyUnits(db, "anon", "acct", day)).toBe(4);
    const { rows } = await sql<{ user_id: string; day: string; units_used: number }>`
      SELECT user_id, day, units_used FROM quota_user_daily ORDER BY user_id, day`.execute(db);
    expect(rows).toEqual([{ user_id: "acct", day, units_used: 9 }]);
    expect(await moveDailyUnits(db, "anon", "acct", day)).toBe(0);
    expect(await moveDailyUnits(db, "acct", "acct", day)).toBe(0);
  });

  test("utcDay uses the UTC date", () => {
    expect(utcDay(new Date("2026-10-28T23:30:00-05:00"))).toBe("2026-10-29");
  });
});
