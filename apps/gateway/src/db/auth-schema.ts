/**
 * Better Auth options that determine the *database schema* only: every
 * plugin that can add tables or columns, with placeholder credentials.
 *
 * Read by `auth-schema.config.ts` (Better Auth's CLI, `auth generate`, which
 * produced `migrations/0001_better_auth.sql`) and by the db test, which checks
 * that Better Auth sees nothing left to migrate after our migrations.
 *
 * The runtime auth instance (task 3.1) MUST use the same plugin set (and the
 * same `rateLimit.storage`) so the committed schema stays valid. When a
 * plugin is added or upgraded, regenerate with `task gateway:auth:generate`
 * and add a new numbered migration for the difference.
 */
import { apiKey } from "@better-auth/api-key";
import type { BetterAuthOptions } from "better-auth";
import { anonymous, captcha, genericOAuth } from "better-auth/plugins";

export const authSchemaOptions = {
  emailAndPassword: { enabled: false },
  socialProviders: {
    github: { clientId: "schema-only", clientSecret: "schema-only" },
  },
  rateLimit: { enabled: true, storage: "database" },
  plugins: [
    anonymous(),
    genericOAuth({
      config: [
        {
          providerId: "orcid",
          clientId: "schema-only",
          clientSecret: "schema-only",
          discoveryUrl: "https://orcid.org/.well-known/openid-configuration",
        },
      ],
    }),
    apiKey(),
    captcha({ provider: "cloudflare-turnstile", secretKey: "schema-only" }),
  ],
} satisfies BetterAuthOptions;

