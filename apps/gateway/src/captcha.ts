/**
 * CAPTCHA on anonymous resolves (task 4.4), Cloudflare Turnstile.
 *
 * `verifyCaptcha` runs on the resolve routes right after `requireIdentity` and
 * BEFORE `requireSignInForLiveRefresh`, `ipGate` and `ensureIdentity`, so a
 * request without a valid token creates no identity and charges nothing.
 *
 * Who needs a token: any request that would be anonymous, i.e. no API key and
 * no signed-in session. That covers a brand-new caller AND an existing
 * anonymous session (the spec: "An anonymous resolve SHALL require a valid
 * CAPTCHA token"), so the web app sends a fresh token with every anonymous
 * resolve in `X-Captcha-Token`. Signed-in users and API keys skip it (the
 * verifier is not called).
 *
 * Status codes:
 * - 401: no session, no key and no token at all (`requireIdentity`, a script
 *   that forgot its key).
 * - 403 `CAPTCHA verification failed`: anonymous request whose token is
 *   missing (existing anonymous session), blank or rejected by Turnstile.
 * - 503: Turnstile could not be reached or answered with an error. Fails
 *   closed: an outage of the verifier never lets anonymous traffic through.
 *   Signed-in users and API keys are unaffected.
 *
 * Tokens are single-use, valid for 300 s, and Turnstile rejects a second
 * verification of the same token, so verdicts are never cached.
 *
 * Verifier: `TURNSTILE_SECRET_KEY` is required in production (`createApp`
 * throws without it). Outside production it falls back to Cloudflare's
 * documented "always passes" test secret, which accepts any token (pair it
 * with the "always passes" test site key `1x00000000000000000000AA`). Optional
 * `TURNSTILE_EXPECTED_HOSTNAME` and `TURNSTILE_EXPECTED_ACTION` make the
 * verifier also require those fields of the siteverify answer to match.
 * Tests inject a stub `CaptchaVerifier` through `AppOptions.captcha`.
 */
import type { MiddlewareHandler } from "hono";
import type { GatewayEnv } from "./forward";
import { UNKNOWN_CLIENT } from "./client-ip";
import { captchaToken } from "./policy";

export const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
/** Cloudflare's documented test secret: every token passes. Development and tests only. */
export const TURNSTILE_TEST_SECRET = "1x0000000000000000000000000000000AA";

/** Thrown by a verifier when it cannot decide (network error, Turnstile outage); the gateway answers 503. */
export class CaptchaUnavailableError extends Error {}

export interface CaptchaVerifier {
  /** True if `token` is valid for this request. `remoteIp` is the resolved client IP, absent when unknown. Throws `CaptchaUnavailableError` if it cannot tell. */
  verify(args: { token: string; remoteIp?: string }): Promise<boolean>;
}

export interface TurnstileOptions {
  secret: string;
  /** Required `hostname` of the answer (the site the widget ran on). Unchecked if unset. */
  expectedHostname?: string;
  /** Required `action` of the answer. Unchecked if unset. */
  expectedAction?: string;
  /** Injectable fetch, for tests. */
  fetch?: typeof fetch;
  /** Request timeout in ms (default 5000). */
  timeoutMs?: number;
}

interface SiteverifyAnswer {
  success?: boolean;
  hostname?: string;
  action?: string;
  "error-codes"?: string[];
}

export function turnstileVerifier(opts: TurnstileOptions): CaptchaVerifier {
  const doFetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  return {
    async verify({ token, remoteIp }) {
      const form = new URLSearchParams({ secret: opts.secret, response: token });
      if (remoteIp) form.set("remoteip", remoteIp);
      let answer: SiteverifyAnswer;
      try {
        const res = await doFetch(SITEVERIFY_URL, {
          method: "POST",
          body: form,
          signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
        });
        if (!res.ok) throw new Error(`siteverify answered ${res.status}`);
        answer = (await res.json()) as SiteverifyAnswer;
      } catch (e) {
        throw new CaptchaUnavailableError(`Turnstile siteverify failed: ${e instanceof Error ? e.message : e}`);
      }
      if (answer.success !== true) {
        // Cloudflare's own failure (not a verdict on the token) is an outage, not a 403.
        if (answer["error-codes"]?.includes("internal-error")) throw new CaptchaUnavailableError("Turnstile internal-error");
        return false;
      }
      if (opts.expectedHostname && answer.hostname !== opts.expectedHostname) return false;
      if (opts.expectedAction && answer.action !== opts.expectedAction) return false;
      return true;
    },
  };
}

/** Verifier from the environment; throws in production without `TURNSTILE_SECRET_KEY`. */
export function captchaFromEnv(env: Record<string, string | undefined> = process.env): CaptchaVerifier {
  const secret = env.TURNSTILE_SECRET_KEY?.trim();
  if (!secret && env.NODE_ENV === "production") {
    throw new Error("TURNSTILE_SECRET_KEY is required in production (Cloudflare Turnstile secret key)");
  }
  return turnstileVerifier({
    secret: secret || TURNSTILE_TEST_SECRET,
    expectedHostname: env.TURNSTILE_EXPECTED_HOSTNAME?.trim() || undefined,
    expectedAction: env.TURNSTILE_EXPECTED_ACTION?.trim() || undefined,
  });
}

const FAILED = { detail: "CAPTCHA verification failed" };

export function verifyCaptcha(verifier: CaptchaVerifier): MiddlewareHandler<GatewayEnv> {
  return async (c, next) => {
    // Signed-in sessions and API keys (withKey sets isAnonymous=false) skip the check.
    if (c.get("isAnonymous") === false) return next();
    const token = captchaToken(c);
    if (!token) return c.json(FAILED, 403);
    const remoteIp = c.get("clientIp");
    let ok: boolean;
    try {
      ok = await verifier.verify({ token, remoteIp: remoteIp && remoteIp !== UNKNOWN_CLIENT ? remoteIp : undefined });
    } catch (e) {
      console.error("captcha verification unavailable", e);
      return c.json({ detail: "CAPTCHA verification unavailable, try again shortly" }, 503);
    }
    return ok ? next() : c.json(FAILED, 403);
  };
}
