/**
 * Email policy for OAuth sign-ins: the single place that decides which email
 * Better Auth ever sees for a provider identity.
 *
 * Invariant: Better Auth only ever receives either
 *   - an email the provider reported as verified (`emailVerified: true`), or
 *   - a placeholder address unique to that provider account
 *     (`<provider>-<accountId>@<PLACEHOLDER_DOMAIN>`, `emailVerified: false`).
 *
 * Why this is needed, not just Better Auth's own checks:
 * - Better Auth looks up an existing user by email and, if found, either links
 *   (merge) or refuses the sign-in with "account not linked". It never creates
 *   a second account with the same email (`user.email` is unique). The spec
 *   wants a *separate account* for an unverified email, so the unverified
 *   address must not reach Better Auth at all.
 * - Better Auth requires an email for every user; ORCID returns none.
 * - Manual linking of a provider with no verified email needs that provider in
 *   `accountLinking.trustedProviders`, and trusted providers skip the
 *   "provider email verified" check for automatic merges too. With this policy
 *   an unverified address can never match another user, so trusting the
 *   providers cannot cause an unverified merge.
 *
 * `validateUserInfo` (see `assertOAuthEmailPolicy`) re-checks the invariant on
 * every OAuth create/sign-in/link, so a provider added later without going
 * through `applyEmailPolicy` fails closed instead of merging.
 */

/** RFC 2606 reserved TLD: can never be a real, provider-verified mailbox. */
export const PLACEHOLDER_DOMAIN = "users.noreply.invalid";

export function placeholderEmail(providerId: string, accountId: string): string {
  const safe = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  return `${safe(providerId)}-${safe(accountId)}@${PLACEHOLDER_DOMAIN}`;
}

export function isPlaceholderEmail(email: string | null | undefined): boolean {
  return typeof email === "string" && email.toLowerCase().endsWith(`@${PLACEHOLDER_DOMAIN}`);
}

/**
 * Keep the provider's email only if it is present and verified (strictly
 * `true`; truthy strings such as `"false"` do not count). Otherwise use the
 * account's placeholder.
 */
export function applyEmailPolicy(
  providerId: string,
  accountId: string,
  email: unknown,
  emailVerified: unknown,
): { email: string; emailVerified: boolean } {
  if (emailVerified === true && typeof email === "string") {
    const trimmed = email.trim().toLowerCase();
    if (trimmed && !isPlaceholderEmail(trimmed)) return { email: trimmed, emailVerified: true };
  }
  return { email: placeholderEmail(providerId, accountId), emailVerified: false };
}

/**
 * `user.validateUserInfo` gate: for OAuth sources, any non-placeholder email
 * must be verified. Returns an error object (Better Auth then refuses with
 * 403 / an OAuth error redirect) or undefined to allow.
 */
export function assertOAuthEmailPolicy(data: {
  user: { email?: string | null; emailVerified?: boolean | null };
  source: { method: string };
}): { error: string; errorDescription: string } | undefined {
  if (data.source.method !== "oauth") return undefined;
  const { email, emailVerified } = data.user;
  if (!email) return { error: "email_policy_violation", errorDescription: "OAuth identity has no email" };
  if (!isPlaceholderEmail(email) && emailVerified !== true) {
    return { error: "email_policy_violation", errorDescription: "Unverified provider email" };
  }
  return undefined;
}
