/**
 * API keys for signed-in users (Better Auth's `@better-auth/api-key` plugin).
 *
 * Management: thin gateway routes under `/api/keys` that call the plugin
 * in-process. The plugin's own HTTP routes (`/api/auth/api-key/*`) are
 * disabled (`API_KEY_DISABLED_PATHS`): they would let an anonymous session
 * create keys and list rows with internal fields. Our routes refuse anonymous
 * sessions and return a fixed set of fields.
 *
 * Authentication: `withApiKey` verifies `x-api-key` on the forwarded routes.
 *
 * Precedence: a request that carries a key is identified by the key ONLY. A
 * valid key beats any session cookie (explicit credential over ambient
 * one; usage is drawn from the key owner's quota, as the spec says), and an
 * invalid key is a 401 even when a valid cookie is present (no silent
 * fallback to another identity).
 *
 * Plugin behavior that MUST stay off (see `apiKeyPlugin`): per-key rate limit
 * (default 10 per 24 h) and per-key `remaining`; quotas are per user and
 * enforced by the gateway (tasks 4.x). Keys are stored as SHA-256 hashes
 * (the plugin's default); only the first characters (`start`) are kept.
 */
import { apiKey } from "@better-auth/api-key";
import type { Context, MiddlewareHandler, Next } from "hono";
import { sql } from "kysely";
import type { Database } from "../db";
import type { GatewayEnv } from "../forward";
import { API_KEY_HEADER, hasApiKey } from "./anonymous";
import type { GatewayAuth } from "./index";

/** The plugin's HTTP routes; ours replace them. */
export const API_KEY_DISABLED_PATHS = [
  "/api-key/create",
  "/api-key/get",
  "/api-key/list",
  "/api-key/update",
  "/api-key/delete",
  "/api-key/delete-all-expired-api-keys",
];

export const KEYS_PATH = "/api/keys";

/** Plugin configuration for the runtime auth instance. */
export function apiKeyPlugin() {
  return apiKey({
    // Quotas are per user, enforced by the gateway; the plugin's default
    // limiter (10 requests per key per 24 h) would cap every key.
    rateLimit: { enabled: false },
    requireName: true,
    defaultPrefix: "qrb_",
    // Sessions from keys would let a key reach /api/auth/* as its owner.
    enableSessionForAPIKeys: false,
  });
}

/**
 * Better Auth `databaseHooks.user.delete.after`: the `apikey` table has no
 * foreign key to `user`, so remove a deleted user's keys explicitly.
 */
export function deleteKeysOfUser(db: Database) {
  return async (user: { id: string }): Promise<void> => {
    await sql`DELETE FROM "apikey" WHERE "referenceId" = ${user.id}`.execute(db);
  };
}

const unauthorized = (c: Context<GatewayEnv>) => c.json({ detail: "Invalid, revoked or expired API key" }, 401);

/**
 * Identifies the caller by `x-api-key` when present: valid key sets `userId`
 * to the owner, `isAnonymous` to false (replacing any session identity)
 * and `apiKeyId` to the key's id (per-key burst limit); otherwise 401 and
 * nothing further runs. Without the header it does nothing.
 */
export function withApiKey(getAuth: () => Promise<GatewayAuth>): MiddlewareHandler<GatewayEnv> {
  return async (c: Context<GatewayEnv>, next: Next) => {
    if (!hasApiKey(c)) return next();
    const key = c.req.header(API_KEY_HEADER) ?? "";
    if (!key) return unauthorized(c);
    const auth = await getAuth();
    const result = await auth.api.verifyApiKey({ body: { key } });
    const ownerId = result.valid ? result.key?.referenceId : undefined;
    if (!ownerId) return unauthorized(c);
    c.set("userId", ownerId);
    c.set("isAnonymous", false);
    c.set("apiKeyId", result.key!.id);
    return next();
  };
}

/** Key fields returned to clients. Never the secret, its hash or internals. */
function publicKey(k: { id: string; name?: string | null; start?: string | null; prefix?: string | null; createdAt: Date | string }) {
  return {
    id: k.id,
    name: k.name ?? null,
    start: k.start ?? null,
    prefix: k.prefix ?? null,
    createdAt: new Date(k.createdAt).toISOString(),
  };
}

/**
 * Handlers for `POST /api/keys`, `GET /api/keys` and `DELETE /api/keys/:id`.
 * Mount after `sessionUser`; they act on the session user and refuse
 * anonymous sessions (403) and callers with no session (401). A request that
 * carries `x-api-key` is refused too: keys cannot manage keys.
 */
export function keyRoutes(getAuth: () => Promise<GatewayAuth>) {
  const guard: MiddlewareHandler<GatewayEnv> = async (c, next) => {
    const userId = c.get("userId");
    if (hasApiKey(c) || !userId) return c.json({ detail: "Sign in to manage API keys" }, 401);
    if (c.get("isAnonymous") !== false) return c.json({ detail: "Sign in with an account to manage API keys" }, 403);
    c.header("cache-control", "no-store");
    return next();
  };

  const create = async (c: Context<GatewayEnv>) => {
    const body = (await c.req.json().catch(() => null)) as { name?: unknown } | null;
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 32) return c.json({ detail: "name is required (1 to 32 characters)" }, 400);
    const auth = await getAuth();
    const created = await auth.api.createApiKey({ headers: c.req.raw.headers, body: { name } });
    // `key` is the only time the secret is available.
    return c.json({ ...publicKey(created), key: created.key }, 201);
  };

  const list = async (c: Context<GatewayEnv>) => {
    const auth = await getAuth();
    const res = await auth.api.listApiKeys({ headers: c.req.raw.headers });
    return c.json({ keys: res.apiKeys.map(publicKey) });
  };

  const revoke = async (c: Context<GatewayEnv>) => {
    const auth = await getAuth();
    try {
      await auth.api.deleteApiKey({ headers: c.req.raw.headers, body: { keyId: c.req.param("id") ?? "" } });
    } catch (e) {
      if ((e as { status?: unknown }).status === "NOT_FOUND") return c.json({ detail: "API key not found" }, 404);
      throw e;
    }
    return c.json({ success: true });
  };

  return { guard, create, list, revoke };
}
