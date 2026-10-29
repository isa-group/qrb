"use client";

import { anonymousClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

import { API_BASE_URL } from "@/lib/api/client";

// Better Auth is mounted by the gateway at <api base>/auth (same origin by
// default). Email/password is disabled server-side; only GitHub and ORCID
// social sign-in are used. ORCID is registered as a social provider on the
// server (generic OAuth plugin), so the plain social endpoints serve it too.
// During the static export's prerender there is no window and a relative base
// is rejected; the placeholder origin is never used for a request (only the
// browser makes calls).
const authBase = `${API_BASE_URL}/auth`;
export const authClient = createAuthClient({
  baseURL: authBase.startsWith("/") && typeof window === "undefined" ? `http://localhost${authBase}` : authBase,
  fetchOptions: { credentials: "include" },
  // Only for the `isAnonymous` field on the session user type.
  plugins: [anonymousClient()],
});

export type Provider = "github" | "orcid";

export const PROVIDERS: { id: Provider; label: string }[] = [
  { id: "github", label: "GitHub" },
  { id: "orcid", label: "ORCID" },
];

export const DEFAULT_NEXT = "/playground";

// Only same-origin absolute paths are honoured as a return target.
export function safeNext(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    return DEFAULT_NEXT;
  }
  return value;
}

// With the default same-origin API base a relative path is resolved by the
// server against its own origin. With a cross-origin dev base the redirect
// must point back at the web origin instead.
export function returnUrl(path: string): string {
  const crossOrigin = !API_BASE_URL.startsWith("/") &&
    typeof window !== "undefined" &&
    new URL(API_BASE_URL).origin !== window.location.origin;
  return crossOrigin ? new URL(path, window.location.origin).toString() : path;
}

// Better Auth redirects back with ?error=<code> (and sometimes
// &error_description=...). Translate the ones a user can hit.
export function describeAuthError(code: string | null | undefined, description?: string | null): string | null {
  if (!code) return null;
  switch (code.toLowerCase()) {
    case "account_not_linked":
      return "An account with this email already exists, but it is not linked to this sign-in method. Sign in with the provider you used before, then link this one from your account page.";
    case "unable_to_link_account":
      return "That provider account could not be linked. It may already belong to another QRB account.";
    case "email_not_found":
    case "email_doesn't_match":
      return "The provider did not give us an email address we can use. Make a verified email visible on that account, or sign in with the other provider.";
    case "access_denied":
      return "Sign-in was cancelled at the provider.";
    case "signup_disabled":
      return "New accounts cannot be created with that sign-in method.";
    case "state_mismatch":
    case "invalid_state":
    case "please_restart_the_process":
      return "The sign-in attempt expired or was interrupted. Please try again.";
    case "unable_to_get_user_info":
      return "The provider did not return your profile. Please try again.";
    default:
      return description
        ? `Sign-in failed: ${description}`
        : "Sign-in failed. Please try again; if it keeps happening, try the other provider.";
  }
}

// Start a provider redirect (sign-in or link). Resolves only if the redirect
// could not start; on success the browser navigates away.
export async function startOAuth(
  mode: "sign-in" | "link",
  provider: Provider,
  next: string,
  errorPath: string,
): Promise<string | null> {
  const body = {
    provider,
    callbackURL: returnUrl(next),
    errorCallbackURL: returnUrl(errorPath),
  };
  // `provider` is typed as the built-in social providers; ORCID is added by a
  // server plugin, so widen it.
  const res =
    mode === "link"
      ? await authClient.linkSocial(body as Parameters<typeof authClient.linkSocial>[0])
      : await authClient.signIn.social(body as Parameters<typeof authClient.signIn.social>[0]);
  if (res.error) {
    return res.error.status === 429
      ? "Too many attempts. Please wait a few seconds and try again."
      : res.error.message || "Could not start sign-in. Please try again.";
  }
  return null;
}
