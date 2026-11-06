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

/** Each account holds at most this many API keys; revoke the current one to replace it. */
export const MAX_KEYS_PER_USER = 1;
const ONE_KEY = "This account already has an API key. Revoke it to create a new one.";

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
    if (result.key!.start) c.set("apiKeyStart", result.key!.start);
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
 *
 * One key per account (`MAX_KEYS_PER_USER`): creating a second one is 409.
 * Creates for one account run one at a time in this process (the gateway is
 * a single instance), so the count check cannot race. Across instances the
 * count is checked again after creating, and a key that is not among the
 * account's oldest is deleted again.
 */
export function keyRoutes(getAuth: () => Promise<GatewayAuth>) {
  const guard: MiddlewareHandler<GatewayEnv> = async (c, next) => {
    const userId = c.get("userId");
    if (hasApiKey(c) || !userId) return c.json({ detail: "Sign in to manage API keys" }, 401);
    if (c.get("isAnonymous") !== false) return c.json({ detail: "Sign in with an account to manage API keys" }, 403);
    c.header("cache-control", "no-store");
    return next();
  };

  const keyIds = async (db: Database, userId: string) =>
    (
      await sql<{ id: string }>`SELECT id FROM "apikey" WHERE "referenceId" = ${userId} ORDER BY "createdAt", id`.execute(db)
    ).rows.map((r) => r.id);

  // Per-account queue: each create waits for the previous one of the same account.
  const queues = new Map<string, Promise<unknown>>();
  const serial = <T>(userId: string, run: () => Promise<T>): Promise<T> => {
    const prev = queues.get(userId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(run);
    queues.set(userId, next);
    void next.finally(() => queues.get(userId) === next && queues.delete(userId)).catch(() => undefined);
    return next;
  };

  const create = (c: Context<GatewayEnv>) => serial(c.get("userId")!, () => createOne(c));

  const createOne = async (c: Context<GatewayEnv>) => {
    const body = (await c.req.json().catch(() => null)) as { name?: unknown } | null;
    const name = typeof body?.name === "string" ? body.name.trim() : "API key";
    if (!name || name.length > 32) return c.json({ detail: "name must be 1 to 32 characters" }, 400);
    const auth = await getAuth();
    const db = auth.options.database.db as Database;
    const userId = c.get("userId")!;
    if ((await keyIds(db, userId)).length >= MAX_KEYS_PER_USER) return c.json({ detail: ONE_KEY }, 409);
    const created = await auth.api.createApiKey({ headers: c.req.raw.headers, body: { name } });
    if (!(await keyIds(db, userId)).slice(0, MAX_KEYS_PER_USER).includes(created.id)) {
      await auth.api.deleteApiKey({ headers: c.req.raw.headers, body: { keyId: created.id } });
      return c.json({ detail: ONE_KEY }, 409);
    }
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
