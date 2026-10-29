/**
 * Better Auth in the gateway, with GitHub and ORCID mocked at the HTTP level
 * (see `./helpers/providers.ts`).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { getMigrations } from "better-auth/db/migration";
import { sql } from "kysely";
import { acceptCaptcha } from "./helpers/captcha";
import { createApp } from "../src/app";
import { createAuth, type AuthConfig, type GatewayAuth } from "../src/auth";
import { authConfigFromEnv } from "../src/auth/config";
import { applyEmailPolicy, assertOAuthEmailPolicy, isPlaceholderEmail, placeholderEmail } from "../src/auth/email-policy";
import { createTestDatabase, type Database } from "../src/db";
import { migrateUp } from "../src/db/migrator";
import {
  accountsOf,
  baseConfig,
  call,
  counts,
  fakeProviders,
  github,
  identities,
  Jar,
  oauth,
  orcid,
  ORCID,
  ORIGIN,
  realFetch,
  session,
  signedInUserId,
  unexpected,
  type App,
  BEHIND_PROXY,
} from "./helpers/providers";

// --- fixtures -----------------------------------------------------------------

let db: Database;
let auth: GatewayAuth;
let app: App;
const upstreamSeen: Request[] = [];

function buildApp(config: AuthConfig = baseConfig) {
  auth = createAuth(db, config, { logLevel: "error" });
  return createApp({
    ...BEHIND_PROXY,
    captcha: acceptCaptcha,
    auth,
    upstreamUrl: "http://upstream.test:8000",
    secret: "s",
    fetch: async (r) => (upstreamSeen.push(r), Response.json({ ok: true })),
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
  upstreamSeen.length = 0;
  db = createTestDatabase();
  await migrateUp(db);
  app = buildApp();
});
afterEach(async () => {
  expect(unexpected).toEqual([]);
  await db.destroy();
});

// --- Accounts -------------------------------------------------------------------

describe("Accounts", () => {
  test("sign up with GitHub creates an account and an HttpOnly, SameSite=Lax session cookie", async () => {
    github("c1", 101, "alice@example.org", true);
    const jar = new Jar();
    const { authorize, location } = await oauth(app, jar, "github", "c1");

    expect(authorize.origin + authorize.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/auth/callback/github`);
    expect(location).toBe("/done");

    const cookieLine = jar.setCookies.find((l) => l.startsWith("better-auth.session_token="));
    expect(cookieLine).toBeDefined();
    expect(cookieLine).toMatch(/;\s*HttpOnly/i);
    expect(cookieLine).toMatch(/;\s*SameSite=Lax/i);
    expect(cookieLine).toMatch(/;\s*Path=\//i);
    expect(cookieLine).not.toMatch(/;\s*Secure/i); // dev (http) config

    expect(await counts(db)).toEqual({ users: 1, accounts: 1, sessions: 1 });
    const s = await session(app, jar);
    expect(s!.user).toMatchObject({ email: "alice@example.org", emailVerified: true });
    expect(await accountsOf(db, s!.user.id)).toEqual([{ providerId: "github", accountId: "101" }]);

    // Later requests are attributed to that user (forwarded as X-QRB-User-Id).
    const res = await app.request(`${ORIGIN}/api/engines`, { headers: { cookie: jar.header() } });
    expect(res.status).toBe(200);
    expect(upstreamSeen.at(-1)!.headers.get("x-qrb-user-id")).toBe(s!.user.id);
    // ...and without a session, no user id is sent.
    await app.request(`${ORIGIN}/api/engines`);
    expect(upstreamSeen.at(-1)!.headers.get("x-qrb-user-id")).toBeNull();
  });

  test("session cookie is Secure (with the __Secure- prefix) outside dev", async () => {
    const httpsOrigin = "https://qrb.example.org";
    app = buildApp({ ...baseConfig, baseURL: httpsOrigin, secureCookies: true, trustedOrigins: [httpsOrigin] });
    github("c1", 101, "alice@example.org", true);
    const jar = new Jar();
    await oauth(app, jar, "github", "c1", "sign-in", httpsOrigin);
    const cookieLine = jar.setCookies.find((l) => l.startsWith("__Secure-better-auth.session_token="));
    expect(cookieLine).toBeDefined();
    expect(cookieLine).toMatch(/;\s*Secure/i);
    expect(cookieLine).toMatch(/;\s*HttpOnly/i);
    expect(cookieLine).toMatch(/;\s*SameSite=Lax/i);
  });

  test("sign out clears the cookie and the old session can no longer be used", async () => {
    github("c1", 101, "alice@example.org", true);
    const jar = new Jar();
    await oauth(app, jar, "github", "c1");
    const stolen = jar.header(); // what an attacker who copied the cookie would hold
    expect(await session(app, jar)).not.toBeNull();

    const out = await call(app, jar, "POST", "/sign-out", {});
    expect(out.status).toBe(200);
    const cleared = jar.setCookies.filter((l) => l.startsWith("better-auth.session_token="));
    expect(cleared.at(-1)).toMatch(/Max-Age=0/i);
    expect(jar.cookies.has("better-auth.session_token")).toBe(false);
    expect((await counts(db)).sessions).toBe(0);

    const replay = await app.request(`${ORIGIN}/api/auth/get-session`, { headers: { cookie: stolen } });
    expect(await replay.json()).toBeNull();
  });

  test("email and password routes do not exist and create no account", async () => {
    const body = { email: "mallory@example.org", password: "correct horse battery staple", name: "M" };
    for (const path of ["/sign-up/email", "/sign-in/email", "/request-password-reset", "/reset-password", "/send-verification-email"]) {
      const res = await call(app, new Jar(), "POST", path, body);
      expect([path, res.status]).toEqual([path, 404]);
    }
    expect(await counts(db)).toEqual({ users: 0, accounts: 0, sessions: 0 });
  });

  test("only GitHub and ORCID are sign-in providers", async () => {
    const res = await call(app, new Jar(), "POST", "/sign-in/social", { provider: "google", callbackURL: "/" });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await counts(db)).toEqual({ users: 0, accounts: 0, sessions: 0 });
  });

  test("ORCID sign-in uses the configured issuer's endpoints and the openid scope", async () => {
    orcid("o1", "0000-0002-1825-0097");
    const { authorize, location } = await oauth(app, new Jar(), "orcid", "o1");
    expect(authorize.origin + authorize.pathname).toBe(`${ORCID}/oauth/authorize`);
    expect(authorize.searchParams.get("scope")).toBe("openid");
    expect(authorize.searchParams.get("client_id")).toBe("APP-TEST");
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/auth/callback/orcid`);
    expect(location).toBe("/done");
  });

  test("auth routes are rate limited per client IP, in the database", async () => {
    const ip = "203.0.113.9";
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await call(app, new Jar(), "POST", "/sign-in/social", { provider: "github", callbackURL: "/" }, { ip });
      statuses.push(res.status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]); // sign-in: 3 per 10 s
    // Another client is unaffected.
    const other = await call(app, new Jar(), "POST", "/sign-in/social", { provider: "github", callbackURL: "/" }, { ip: "203.0.113.10" });
    expect(other.status).toBe(200);
    const { rows } = await sql<{ key: string; count: number }>`SELECT key, count FROM "rateLimit" ORDER BY key`.execute(db);
    expect(rows).toContainEqual({ key: `${ip}|/sign-in/social`, count: 3 });
  });
});

// --- Account merging on verified email -------------------------------------------

describe("Account merging on verified email", () => {
  test("ORCID account, then GitHub with the same verified email: same user, GitHub linked", async () => {
    orcid("o1", "0000-0002-1825-0097", "Ada@Example.org", true);
    github("g1", 202, "ada@example.org", true);

    const a = new Jar();
    await oauth(app, a, "orcid", "o1");
    const orcidUser = await signedInUserId(app, a);

    const b = new Jar();
    const { location } = await oauth(app, b, "github", "g1");
    expect(location).toBe("/done");
    expect(await signedInUserId(app, b)).toBe(orcidUser);

    expect((await counts(db)).users).toBe(1);
    expect(await accountsOf(db, orcidUser)).toEqual([
      { providerId: "github", accountId: "202" },
      { providerId: "orcid", accountId: "0000-0002-1825-0097" },
    ]);
  });

  test("GitHub email equal to an existing account's but unverified: separate account", async () => {
    github("g1", 301, "bob@example.org", true);
    github("g2", 302, "bob@example.org", false); // attacker added the victim's address, unverified
    const victim = new Jar();
    await oauth(app, victim, "github", "g1");
    const victimId = await signedInUserId(app, victim);

    const attacker = new Jar();
    const { location } = await oauth(app, attacker, "github", "g2");
    expect(location).toBe("/done");
    const s = await session(app, attacker);
    expect(s!.user.id).not.toBe(victimId);
    expect(s!.user.email).toBe(placeholderEmail("github", "302"));
    expect(s!.user.emailVerified).toBe(false);
    expect(await accountsOf(db, victimId)).toEqual([{ providerId: "github", accountId: "301" }]);
    expect((await counts(db)).users).toBe(2);
  });

  test("ORCID email equal to an existing account's but not verified (or not strictly true): separate accounts", async () => {
    github("g1", 401, "carol@example.org", true);
    orcid("o1", "0000-0001-0000-0001", "carol@example.org", false);
    orcid("o2", "0000-0001-0000-0002", "carol@example.org"); // no email_verified claim
    orcid("o3", "0000-0001-0000-0003", "carol@example.org", "true"); // string, not boolean
    const victim = new Jar();
    await oauth(app, victim, "github", "g1");
    const victimId = await signedInUserId(app, victim);

    for (const code of ["o1", "o2", "o3"]) {
      const jar = new Jar();
      await oauth(app, jar, "orcid", code);
      const s = await session(app, jar);
      expect(s!.user.id).not.toBe(victimId);
      expect(isPlaceholderEmail(s!.user.email)).toBe(true);
    }
    expect((await counts(db)).users).toBe(4);
    expect(await accountsOf(db, victimId)).toEqual([{ providerId: "github", accountId: "401" }]);
  });

  test("ORCID returns no email: separate account, and the same ORCID iD signs back into it", async () => {
    github("g1", 501, "dan@example.org", true);
    orcid("o1", "0000-0003-1415-926X"); // userinfo has no email; id_token carries a forged one
    const gh = new Jar();
    await oauth(app, gh, "github", "g1");
    const githubUser = await signedInUserId(app, gh);

    const first = new Jar();
    await oauth(app, first, "orcid", "o1");
    const s = await session(app, first);
    expect(s!.user.id).not.toBe(githubUser);
    expect(s!.user.email).toBe(placeholderEmail("orcid", "0000-0003-1415-926X"));
    expect(s!.user.emailVerified).toBe(false);

    const again = new Jar();
    await oauth(app, again, "orcid", "o1");
    expect(await signedInUserId(app, again)).toBe(s!.user.id);
    expect((await counts(db)).users).toBe(2);
  });

  test("a forged ORCID id_token email is ignored (userinfo is the only source)", async () => {
    // The fake token endpoint's id_token claims victim@example.org, verified.
    github("g1", 601, "victim@example.org", true);
    orcid("o1", "0000-0002-0000-0006");
    const victim = new Jar();
    await oauth(app, victim, "github", "g1");
    const victimId = await signedInUserId(app, victim);

    const jar = new Jar();
    await oauth(app, jar, "orcid", "o1");
    expect(await signedInUserId(app, jar)).not.toBe(victimId);
  });
});

// --- Manual account linking -------------------------------------------------------

describe("Manual account linking", () => {
  test("link ORCID (no email) while signed in with GitHub: either provider signs into the same account", async () => {
    github("g1", 701, "erin@example.org", true);
    orcid("o1", "0000-0002-0000-0007");
    const jar = new Jar();
    await oauth(app, jar, "github", "g1");
    const userId = await signedInUserId(app, jar);

    const { location } = await oauth(app, jar, "orcid", "o1", "link");
    expect(location).toBe("/done");
    expect(await accountsOf(db, userId)).toEqual([
      { providerId: "github", accountId: "701" },
      { providerId: "orcid", accountId: "0000-0002-0000-0007" },
    ]);

    const viaOrcid = new Jar();
    await oauth(app, viaOrcid, "orcid", "o1");
    expect(await signedInUserId(app, viaOrcid)).toBe(userId);
    const viaGithub = new Jar();
    await oauth(app, viaGithub, "github", "g1");
    expect(await signedInUserId(app, viaGithub)).toBe(userId);
    expect((await counts(db)).users).toBe(1);
  });

  test("linking requires a session", async () => {
    const res = await call(app, new Jar(), "POST", "/link-social", { provider: "orcid", callbackURL: "/" });
    expect(res.status).toBe(401);
  });

  test("a provider account already linked to another user cannot be linked again", async () => {
    github("g1", 801, "f@example.org", true);
    github("g2", 802, "g@example.org", true);
    const owner = new Jar();
    await oauth(app, owner, "github", "g1");
    const ownerId = await signedInUserId(app, owner);

    const other = new Jar();
    await oauth(app, other, "github", "g2");
    const { location } = await oauth(app, other, "github", "g1", "link");
    expect(location).toStartWith("/oauth-error?error=");
    expect(await accountsOf(db, ownerId)).toEqual([{ providerId: "github", accountId: "801" }]);
  });

  test("unlinking the only provider is refused; unlinking one of two is allowed", async () => {
    github("g1", 901, "h@example.org", true);
    orcid("o1", "0000-0002-0000-0009");
    const jar = new Jar();
    await oauth(app, jar, "github", "g1");
    const userId = await signedInUserId(app, jar);

    const list = async () =>
      (await (await call(app, jar, "GET", "/list-accounts")).json()) as { id: string; providerId: string }[];

    const [only] = await list();
    const refused = await call(app, jar, "POST", "/unlink-account", { accountId: only!.id });
    expect(refused.status).toBe(400);
    expect(await accountsOf(db, userId)).toHaveLength(1);

    await oauth(app, jar, "orcid", "o1", "link");
    const both = await list();
    expect(both.map((a) => a.providerId).sort()).toEqual(["github", "orcid"]);
    const orcidAccount = both.find((a) => a.providerId === "orcid")!;
    const ok = await call(app, jar, "POST", "/unlink-account", { accountId: orcidAccount.id });
    expect(ok.status).toBe(200);

    const [last] = await list();
    expect(last!.providerId).toBe("github");
    const refusedAgain = await call(app, jar, "POST", "/unlink-account", { accountId: last!.id });
    expect(refusedAgain.status).toBe(400);
    expect(await accountsOf(db, userId)).toEqual([{ providerId: "github", accountId: "901" }]);
  });
});

// --- configuration and invariants -----------------------------------------------

describe("auth configuration", () => {
  test("runtime plugin set matches the committed schema (nothing left to migrate)", async () => {
    const plan = await getMigrations(auth.options, { throwOnUnsafe: false });
    expect(plan.toBeCreated.map((t) => t.table)).toEqual([]);
    expect(plan.toBeAdded.map((t) => [t.table, Object.keys(t.fields)])).toEqual([]);
    expect(plan.toBeAddedIndexes.map((i) => i.name)).toEqual([]);
  });

  test("production fails fast without secret, https base URL or OAuth credentials", () => {
    const full = {
      NODE_ENV: "production",
      BETTER_AUTH_SECRET: "x".repeat(40),
      BETTER_AUTH_URL: "https://qrb.example.org",
      GITHUB_CLIENT_ID: "a",
      GITHUB_CLIENT_SECRET: "b",
      ORCID_CLIENT_ID: "c",
      ORCID_CLIENT_SECRET: "d",
      WEB_ORIGINS: "http://localhost:3000",
    };
    const cfg = authConfigFromEnv(full);
    expect(cfg).toMatchObject({
      secureCookies: true,
      trustedOrigins: ["https://qrb.example.org"], // WEB_ORIGINS is dev-only
      orcid: { issuer: "https://orcid.org" },
    });
    for (const name of ["BETTER_AUTH_SECRET", "BETTER_AUTH_URL", "GITHUB_CLIENT_SECRET", "ORCID_CLIENT_ID"]) {
      expect(() => authConfigFromEnv({ ...full, [name]: "" })).toThrow(name);
    }
    expect(() => authConfigFromEnv({ ...full, BETTER_AUTH_SECRET: "short" })).toThrow("at least");
    expect(() => authConfigFromEnv({ ...full, BETTER_AUTH_URL: "http://qrb.example.org" })).toThrow("https");
  });

  test("development: placeholders, sandbox ORCID, WEB_ORIGINS trusted, no Secure on http", () => {
    const cfg = authConfigFromEnv({ NODE_ENV: "test", WEB_ORIGINS: "http://localhost:3000, http://localhost:3002" });
    expect(cfg).toMatchObject({
      baseURL: "http://localhost:3001",
      secureCookies: false,
      trustedOrigins: ["http://localhost:3001", "http://localhost:3000", "http://localhost:3002"],
      orcid: { issuer: "https://sandbox.orcid.org" },
    });
    expect(authConfigFromEnv({ NODE_ENV: "test", ORCID_ISSUER: "https://orcid.org/" }).orcid.issuer).toBe("https://orcid.org");
  });

  test("email policy keeps only strictly verified emails; validateUserInfo rejects anything else", () => {
    expect(applyEmailPolicy("github", "1", "A@B.org", true)).toEqual({ email: "a@b.org", emailVerified: true });
    for (const verified of [false, undefined, "true", 1]) {
      expect(applyEmailPolicy("github", "1", "a@b.org", verified)).toEqual({
        email: "github-1@users.noreply.invalid",
        emailVerified: false,
      });
    }
    expect(applyEmailPolicy("orcid", "0000-0003-1415-926X", undefined, true).email).toBe(
      "orcid-0000-0003-1415-926x@users.noreply.invalid",
    );
    // A provider cannot smuggle in a placeholder for another account.
    expect(applyEmailPolicy("github", "2", "github-1@users.noreply.invalid", true).email).toBe(
      "github-2@users.noreply.invalid",
    );

    const oauthSource = { method: "oauth" };
    expect(assertOAuthEmailPolicy({ user: { email: "a@b.org", emailVerified: true }, source: oauthSource })).toBeUndefined();
    expect(assertOAuthEmailPolicy({ user: { email: placeholderEmail("orcid", "x"), emailVerified: false }, source: oauthSource })).toBeUndefined();
    expect(assertOAuthEmailPolicy({ user: { email: "a@b.org", emailVerified: false }, source: oauthSource })?.error).toBe("email_policy_violation");
    expect(assertOAuthEmailPolicy({ user: { email: "", emailVerified: true }, source: oauthSource })?.error).toBe("email_policy_violation");
    expect(assertOAuthEmailPolicy({ user: { email: "temp@x.org", emailVerified: false }, source: { method: "anonymous" } })).toBeUndefined();
  });
});
