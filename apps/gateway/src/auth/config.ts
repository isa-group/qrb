/**
 * Auth configuration from the environment. Pure (no I/O) so `createApp()` can
 * validate it at import time and a misconfigured production deployment fails
 * at startup rather than on the first sign-in.
 */

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

export interface AuthConfig {
  /** Public origin of the gateway, e.g. `https://qrb.example.org`. Auth routes live under `<baseURL>/api/auth`. */
  baseURL: string;
  secret: string;
  /** `Secure` session cookies (and the `__Secure-` name prefix). */
  secureCookies: boolean;
  /** Origins allowed to call auth routes and to be used as callback URLs. */
  trustedOrigins: string[];
  github: OAuthClient;
  orcid: OAuthClient & {
    /** `https://orcid.org` (production) or `https://sandbox.orcid.org`. */
    issuer: string;
  };
}

/** Minimum length Better Auth recommends for its secret. */
const MIN_SECRET_LENGTH = 32;
const DEV_SECRET = "qrb-dev-only-insecure-better-auth-secret-do-not-use";
const DEV_BASE_URL = "http://localhost:3001";
export const ORCID_PRODUCTION = "https://orcid.org";
export const ORCID_SANDBOX = "https://sandbox.orcid.org";

const list = (v: string | undefined) =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export function authConfigFromEnv(env: Record<string, string | undefined> = process.env): AuthConfig {
  const production = env.NODE_ENV === "production";
  const problems: string[] = [];
  const quiet = env.NODE_ENV === "test";

  const required = (name: string, devDefault: string): string => {
    const v = env[name]?.trim();
    if (v) return v;
    if (production) problems.push(`${name} must be set`);
    else if (!quiet) console.warn(`${name} is not set; using a development placeholder`);
    return devDefault;
  };

  const secret = required("BETTER_AUTH_SECRET", DEV_SECRET);
  if (production && secret.length < MIN_SECRET_LENGTH) {
    problems.push(`BETTER_AUTH_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
  }

  const baseURL = required("BETTER_AUTH_URL", DEV_BASE_URL).replace(/\/+$/, "");
  let baseOrigin = "";
  try {
    const u = new URL(baseURL);
    baseOrigin = u.origin;
    if (production && u.protocol !== "https:") problems.push("BETTER_AUTH_URL must use https in production");
  } catch {
    problems.push(`BETTER_AUTH_URL is not a valid URL: ${baseURL}`);
  }

  const github = {
    clientId: required("GITHUB_CLIENT_ID", "dev-unset"),
    clientSecret: required("GITHUB_CLIENT_SECRET", "dev-unset"),
  };
  const orcidIssuer = (env.ORCID_ISSUER?.trim() || (production ? ORCID_PRODUCTION : ORCID_SANDBOX)).replace(/\/+$/, "");
  try {
    if (new URL(orcidIssuer).protocol !== "https:") problems.push("ORCID_ISSUER must use https");
  } catch {
    problems.push(`ORCID_ISSUER is not a valid URL: ${orcidIssuer}`);
  }
  const orcid = {
    clientId: required("ORCID_CLIENT_ID", "dev-unset"),
    clientSecret: required("ORCID_CLIENT_SECRET", "dev-unset"),
    issuer: orcidIssuer,
  };

  if (problems.length) throw new Error(`Invalid auth configuration:\n- ${problems.join("\n- ")}`);

  // WEB_ORIGINS is for local development (web on :3000, gateway elsewhere).
  // In production everything is same-origin, so only the base URL is trusted.
  const trustedOrigins = [...new Set([baseOrigin, ...(production ? [] : list(env.WEB_ORIGINS))])];
  // TRUSTED_PROXIES is not auth configuration: the gateway resolves the client
  // IP itself (`../client-ip.ts`) and hands it to Better Auth in a header.

  return {
    baseURL,
    secret,
    secureCookies: production || baseURL.startsWith("https://"),
    trustedOrigins,
    github,
    orcid,
  };
}
