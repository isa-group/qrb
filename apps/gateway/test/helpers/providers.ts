/**
 * Shared test helpers: GitHub and ORCID mocked at the HTTP level, a cookie jar
 * and browser-style OAuth round trips (used by auth and anonymous tests).
 *
 * Better Auth's providers call the global `fetch` (token exchange, GitHub
 * `/user` + `/user/emails`, ORCID `/oauth/userinfo`), so suites install
 * `fakeProviders` as `globalThis.fetch`; it serves fake provider responses and
 * fails on any other outbound request (no network), recording it in
 * `unexpected`.
 *
 * Each OAuth "code" names an identity registered in `identities`, so a test
 * picks which provider account (and which email/verification) a sign-in
 * returns.
 */
import { expect } from "bun:test";
import { sql } from "kysely";
import type { createApp } from "../../src/app";
import type { AuthConfig } from "../../src/auth";
import type { Database } from "../../src/db";

export const ORIGIN = "http://gateway.test";

/**
 * `createApp` options for suites whose requests model the production path:
 * the reverse proxy on 127.0.0.1 forwards them, so their `X-Forwarded-For`
 * is honoured (`app.request` has no socket; see `src/client-ip.ts`).
 */
export const BEHIND_PROXY = { clientAddress: () => "127.0.0.1" } as const;
export const ORCID = "https://sandbox.orcid.org";

export const baseConfig: AuthConfig = {
  baseURL: ORIGIN,
  secret: "test-secret-test-secret-test-secret-0123",
  secureCookies: false,
  trustedOrigins: [ORIGIN],
  github: { clientId: "gh-client", clientSecret: "gh-secret" },
  orcid: { clientId: "APP-TEST", clientSecret: "orcid-secret", issuer: ORCID },
};

// --- fake providers ---------------------------------------------------------

export type GithubIdentity = { provider: "github"; id: number; login: string; email?: string; verified?: boolean };
export type OrcidIdentity = { provider: "orcid"; sub: string; name: string; email?: string; email_verified?: unknown };
export type Identity = GithubIdentity | OrcidIdentity;

export const identities = new Map<string, Identity>();
export const unexpected: string[] = [];
export const realFetch = globalThis.fetch;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function identityFromBearer(req: Request, prefix: string): Identity | undefined {
  const auth = req.headers.get("authorization") ?? "";
  const code = auth.replace(/^Bearer /i, "").replace(prefix, "");
  return identities.get(code);
}

export async function fakeProviders(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const req = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
  const url = new URL(req.url);
  const key = `${req.method} ${url.origin}${url.pathname}`;

  if (key === "POST https://github.com/login/oauth/access_token") {
    const code = new URLSearchParams(await req.text()).get("code") ?? "";
    if (identities.get(code)?.provider !== "github") return json({ error: "bad_verification_code" });
    return json({ access_token: `gh-${code}`, token_type: "bearer", scope: "read:user,user:email" });
  }
  if (key === "GET https://api.github.com/user") {
    const who = identityFromBearer(req, "gh-");
    if (who?.provider !== "github") return json({ message: "Bad credentials" }, 401);
    return json({ id: who.id, login: who.login, name: who.login, email: null, avatar_url: null });
  }
  if (key === "GET https://api.github.com/user/emails") {
    const who = identityFromBearer(req, "gh-");
    if (who?.provider !== "github") return json({ message: "Bad credentials" }, 401);
    return json(who.email ? [{ email: who.email, primary: true, verified: who.verified === true, visibility: null }] : []);
  }
  if (key === `POST ${ORCID}/oauth/token`) {
    const body = new URLSearchParams(await req.text());
    const code = body.get("code") ?? "";
    const who = identities.get(code);
    if (who?.provider !== "orcid" || body.get("client_secret") !== "orcid-secret") {
      return json({ error: "invalid_grant" }, 400);
    }
    // ORCID also returns an id_token; the gateway must not trust it unverified.
    const forged = `e30.${btoa(JSON.stringify({ sub: who.sub, email: "victim@example.org", email_verified: true }))}.x`;
    return json({
      access_token: `orcid-${code}`,
      token_type: "bearer",
      expires_in: 631138518,
      scope: "openid",
      orcid: who.sub,
      name: who.name,
      id_token: forged,
    });
  }
  if (key === `GET ${ORCID}/oauth/userinfo`) {
    const who = identityFromBearer(req, "orcid-");
    if (who?.provider !== "orcid") return json({ error: "invalid_token" }, 401);
    const body: Record<string, unknown> = { sub: who.sub, name: who.name, given_name: who.name, family_name: "" };
    if (who.email !== undefined) body.email = who.email;
    if (who.email_verified !== undefined) body.email_verified = who.email_verified;
    return json(body);
  }
  unexpected.push(key);
  throw new Error(`unexpected outbound request: ${key}`);
}

// --- HTTP helpers -------------------------------------------------------------

export class Jar {
  cookies = new Map<string, string>();
  /** Raw Set-Cookie lines seen, newest last. */
  setCookies: string[] = [];
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  store(res: Response) {
    for (const line of res.headers.getSetCookie()) {
      this.setCookies.push(line);
      const [pair, ...attrs] = line.split(";");
      const i = pair!.indexOf("=");
      const name = pair!.slice(0, i).trim();
      const value = pair!.slice(i + 1).trim();
      const expired = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a)) || value === "";
      if (expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
}

let ipCounter = 0;
export const nextIp = () => `198.51.100.${(ipCounter++ % 250) + 1}`;

export type App = ReturnType<typeof createApp>;

export async function call(
  app: App,
  jar: Jar,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  opts: { ip?: string; origin?: string } = {},
): Promise<Response> {
  const origin = opts.origin ?? ORIGIN;
  const headers: Record<string, string> = { origin, "x-forwarded-for": opts.ip ?? nextIp() };
  const cookie = jar.header();
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await app.request(`${origin}/api/auth${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  jar.store(res);
  return res;
}

/**
 * Full browser-style OAuth round trip: start (sign-in or link), then hit the
 * callback with the code the fake provider will accept.
 */
export async function oauth(app: App, jar: Jar, provider: "github" | "orcid", code: string, mode: "sign-in" | "link" = "sign-in", origin = ORIGIN) {
  const start = await call(app, jar, "POST", mode === "link" ? "/link-social" : "/sign-in/social", { provider, callbackURL: "/done", errorCallbackURL: "/oauth-error" }, { origin });
  expect(start.status).toBe(200);
  const { url } = (await start.json()) as { url: string };
  const authorize = new URL(url);
  const state = authorize.searchParams.get("state");
  expect(state).toBeTruthy();
  const cb = await call(app, jar, "GET", `/callback/${provider}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state!)}`, undefined, { origin });
  expect(cb.status).toBe(302);
  return { authorize, location: cb.headers.get("location") ?? "", response: cb };
}

export async function session(app: App, jar: Jar): Promise<{ user: { id: string; email: string; emailVerified: boolean } } | null> {
  const res = await call(app, jar, "GET", "/get-session");
  expect(res.status).toBe(200);
  return (await res.json()) as never;
}

export async function signedInUserId(app: App, jar: Jar): Promise<string> {
  const s = await session(app, jar);
  expect(s).not.toBeNull();
  return s!.user.id;
}

export const counts = async (db: Database) => {
  const { rows } = await sql<{ users: number; accounts: number; sessions: number }>`
    SELECT (SELECT count(*)::int FROM "user") AS users,
           (SELECT count(*)::int FROM "account") AS accounts,
           (SELECT count(*)::int FROM "session") AS sessions`.execute(db);
  return rows[0]!;
};

export const accountsOf = async (db: Database, userId: string) =>
  (
    await sql<{ providerId: string; accountId: string }>`
      SELECT "providerId", "accountId" FROM "account" WHERE "userId" = ${userId} ORDER BY "providerId"`.execute(db)
  ).rows;

export const github = (code: string, id: number, email?: string, verified?: boolean) =>
  identities.set(code, { provider: "github", id, login: `gh${id}`, email, verified });
export const orcid = (code: string, sub: string, email?: string, email_verified?: unknown) =>
  identities.set(code, { provider: "orcid", sub, name: `Researcher ${sub}`, email, email_verified });
