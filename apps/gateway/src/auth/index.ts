/**
 * Better Auth for the gateway: GitHub and ORCID sign-in only, sessions in
 * Postgres, mounted at `/api/auth/*`.
 *
 * Plugin set MUST match `src/db/auth-schema.ts` (the committed schema):
 * anonymous, generic OAuth (ORCID), API key, captcha. Their behavior is
 * configured by their tasks: anonymous identities and linking in
 * `./anonymous.ts` (3.2); API keys (3.3) and CAPTCHA (4.x) are present only so
 * the runtime and schema agree.
 */
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { anonymous, captcha, genericOAuth } from "better-auth/plugins";
import { github as githubProvider } from "better-auth/social-providers";
import type { Context, MiddlewareHandler, Next } from "hono";
import { betterAuthDatabase, type Database } from "../db";
import type { GatewayEnv } from "../forward";
import { API_KEY_DISABLED_PATHS, apiKeyPlugin, deleteKeysOfUser } from "./api-keys";
import { ANONYMOUS_DISABLED_PATHS, carryOverAnonymousUsage } from "./anonymous";
import { CLIENT_IP_HEADER } from "../client-ip";
import type { AuthConfig } from "./config";
import { applyEmailPolicy, assertOAuthEmailPolicy } from "./email-policy";

export { authConfigFromEnv, type AuthConfig } from "./config";
export { ensureIdentity, hasApiKey, API_KEY_HEADER } from "./anonymous";
export { withApiKey, keyRoutes, KEYS_PATH } from "./api-keys";

export const AUTH_BASE_PATH = "/api/auth";
export const PROVIDERS = ["github", "orcid"] as const;

/**
 * Email/password and email-verification routes. Email/password is disabled
 * (`emailAndPassword.enabled: false`), which already makes these refuse; we
 * also remove them so they answer 404, as the spec says they do not exist.
 */
export const DISABLED_PATHS = [
  "/sign-in/email",
  "/sign-up/email",
  "/change-password",
  "/set-password",
  "/request-password-reset",
  "/reset-password",
  "/forget-password",
  "/send-verification-email",
  "/verify-email",
  "/change-email",
  "/verify-password",
];

/** ORCID iD: four groups of four, last character a digit or X (ISO 7064 checksum). */
const ORCID_ID = /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/;

interface OrcidUserInfo {
  sub?: unknown;
  name?: unknown;
  given_name?: unknown;
  family_name?: unknown;
  email?: unknown;
  email_verified?: unknown;
}

/**
 * ORCID through generic OAuth with explicit endpoints (no discovery fetch at
 * startup). Profile comes from the userinfo endpoint with the access token;
 * the token response's `id_token` is ignored, because without discovery the
 * generic plugin would decode it *unverified*.
 *
 * ORCID's OIDC userinfo returns `sub`, `name`, `given_name`, `family_name` and
 * no email (its discovery document lists no email claim). If a future ORCID
 * response does include an email, it is used only when `email_verified` is
 * strictly `true`; otherwise the account gets a placeholder (no merge).
 */
function orcidConfig(cfg: AuthConfig["orcid"]) {
  const userInfoUrl = `${cfg.issuer}/oauth/userinfo`;
  return {
    providerId: "orcid",
    name: "ORCID",
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    authorizationUrl: `${cfg.issuer}/oauth/authorize`,
    tokenUrl: `${cfg.issuer}/oauth/token`,
    userInfoUrl,
    scopes: ["openid"],
    // ORCID's discovery advertises client_secret_post only; that is Better
    // Auth's default when a secret is set. PKCE parameters are sent too: they
    // add protection if ORCID honors them and are ignored otherwise (RFC 6749
    // section 3.1: unrecognized parameters MUST be ignored).
    async getUserInfo(tokens: { accessToken?: string }) {
      if (!tokens.accessToken) return null;
      const res = await fetch(userInfoUrl, {
        headers: { authorization: `Bearer ${tokens.accessToken}`, accept: "application/json" },
      });
      if (!res.ok) return null;
      const info = (await res.json().catch(() => null)) as OrcidUserInfo | null;
      if (!info || typeof info.sub !== "string" || !ORCID_ID.test(info.sub)) return null;
      const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
      const name = str(info.name) ?? ([str(info.given_name), str(info.family_name)].filter(Boolean).join(" ") || info.sub);
      return {
        id: info.sub,
        name,
        ...applyEmailPolicy("orcid", info.sub, info.email, info.email_verified),
      };
    },
  };
}

/**
 * GitHub with Better Auth's built-in provider, wrapped so its user info goes
 * through the email policy. The built-in provider reports `emailVerified`
 * from `/user/emails` (false when the address is missing from that list).
 */
function githubConfig(cfg: AuthConfig["github"]) {
  const base = githubProvider({ clientId: cfg.clientId, clientSecret: cfg.clientSecret });
  return {
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    async getUserInfo(token: Parameters<typeof base.getUserInfo>[0]) {
      const info = await base.getUserInfo(token);
      const id = (info?.data as { id?: unknown } | undefined)?.id;
      if (!info || (typeof id !== "number" && typeof id !== "string")) return null;
      return {
        user: {
          ...info.user,
          ...applyEmailPolicy("github", String(id), info.user.email, info.user.emailVerified),
        },
        data: info.data,
      };
    },
  };
}

export interface CreateAuthOptions {
  /** Better Auth's logger level; tests may quiet expected OAuth errors. */
  logLevel?: "debug" | "info" | "warn" | "error";
}

export function createAuth(db: Database, config: AuthConfig, opts: CreateAuthOptions = {}) {
  const options = {
    appName: "QRB",
    baseURL: config.baseURL,
    basePath: AUTH_BASE_PATH,
    secret: config.secret,
    database: betterAuthDatabase(db),
    trustedOrigins: config.trustedOrigins,
    logger: opts.logLevel ? { level: opts.logLevel } : undefined,

    emailAndPassword: { enabled: false },
    disabledPaths: [...DISABLED_PATHS, ...ANONYMOUS_DISABLED_PATHS, ...API_KEY_DISABLED_PATHS],
    socialProviders: { github: githubConfig(config.github) },

    user: {
      // Defense in depth for the email policy (see email-policy.ts).
      validateUserInfo: (data) => assertOAuthEmailPolicy(data),
    },

    // `apikey.referenceId` has no foreign key to `user`.
    databaseHooks: { user: { delete: { after: deleteKeysOfUser(db) } } },

    account: {
      accountLinking: {
        enabled: true,
        // Trusted so that a signed-in user can link a provider that reports no
        // verified email (ORCID usually). Safe only because every OAuth email
        // reaching Better Auth is either verified or a per-account placeholder,
        // so an automatic merge can only happen on a verified email.
        trustedProviders: [...PROVIDERS],
        // Manual linking: the linked provider's email need not equal the
        // session user's (ORCID gives a placeholder).
        allowDifferentEmails: true,
        // Automatic merge also needs the existing account's email verified.
        // This is the default; stated because the policy relies on it.
        requireLocalEmailVerified: true,
        // Never leave an account with no way to sign in.
        allowUnlinkingAll: false,
        // Do not copy the linked provider's name/avatar over the account's.
        updateUserInfoOnLink: false,
      },
    },

    // Auth-route limiter (sign-in 3/10 s per IP, others 100/10 s), stored in
    // the `rateLimit` table so limits survive restarts and are shared.
    rateLimit: { enabled: true, storage: "database" },

    advanced: {
      useSecureCookies: config.secureCookies,
      // Explicit, though they are Better Auth's defaults.
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax", path: "/" },
      // The client IP is resolved once by the gateway (`clientIp` middleware,
      // TRUSTED_PROXIES rule) and passed in an internal header whose
      // client-sent copies are stripped. Better Auth reads only that header,
      // never X-Forwarded-For, so its limiter keys on the same IP as ours.
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
    },

    plugins: [
      // Identities are created by `ensureIdentity` (server-side); on sign-in
      // today's units move to the account, then the plugin deletes the
      // anonymous user. Its placeholder email (`@anonymous.placeholder.invalid`,
      // emailVerified false) can never be merged into: automatic linking needs
      // a verified local email (`requireLocalEmailVerified`).
      anonymous({ onLinkAccount: carryOverAnonymousUsage(db) }),
      genericOAuth({ config: [orcidConfig(config.orcid)] }),
      apiKeyPlugin(),
      // Present for schema parity only. Its default endpoints are the email
      // routes, which are disabled, so it never runs; CAPTCHA on resolve
      // routes (and its secret) is configured by tasks 4.x.
      captcha({ provider: "cloudflare-turnstile", secretKey: "not-configured" }),
    ],
  } satisfies BetterAuthOptions;
  return betterAuth(options);
}

export type GatewayAuth = ReturnType<typeof createAuth>;

/** Either an auth instance or a (memoized) async factory for one. */
export type AuthSource = GatewayAuth | (() => Promise<GatewayAuth>);

export function authGetter(source: AuthSource): () => Promise<GatewayAuth> {
  if (typeof source !== "function") return async () => source;
  let pending: Promise<GatewayAuth> | undefined;
  return () => {
    pending ??= source().catch((e) => {
      pending = undefined;
      throw e;
    });
    return pending;
  };
}

/** Handler for `/api/auth/*`: Better Auth's own router. */
export function authHandler(getAuth: () => Promise<GatewayAuth>) {
  return async (c: Context<GatewayEnv>) => (await getAuth()).handler(c.req.raw);
}

/**
 * Resolves the caller's Better Auth session (if any) and sets `userId` and
 * `isAnonymous`. Enforces nothing: a request with no or an invalid session continues with
 * `userId` unset. Policy (401/403/429) is added by tasks 4.x.
 */
export function sessionUser(getAuth: () => Promise<GatewayAuth>): MiddlewareHandler<GatewayEnv> {
  return async (c: Context<GatewayEnv>, next: Next) => {
    const auth = await getAuth();
    // Errors (e.g. database down) propagate as 500 rather than silently
    // treating a signed-in caller as anonymous.
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (session?.user?.id) {
      c.set("userId", session.user.id);
      c.set("isAnonymous", session.user.isAnonymous === true);
    }
    await next();
  };
}
