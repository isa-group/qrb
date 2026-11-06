/**
 * Async binds: `POST /api/binds` takes the same body as `POST /api/select`, answers 202 at once with
 * an id, and resolves in the background; `GET /api/binds/:id` returns its status and, once done, the
 * exact `/select` envelope. For callers whose HTTP call would not survive a slow resolve (a live
 * provider refresh takes tens of seconds): scripts, notebooks, CI, short proxy timeouts.
 *
 * A bind selects a QPU; nothing is executed. These are binds with a status, never "jobs".
 *
 * - Accounts only (a signed-in session or an API key): a keyless caller is identified by IP, which
 *   is too weak to own a result, so it uses the synchronous `/select`.
 * - Charged like `/select` when accepted (the same `burst` and `quota` middleware). An upstream 5xx,
 *   an unreachable API or a timeout fails the bind and refunds its units; an upstream 4xx (e.g. QASM
 *   that does not parse) fails it and keeps the charge, as on `/select`.
 * - At most `MAX_PENDING_BINDS` pending per account (429 above).
 * - Stored in `bind_history` (the Account page lists them) and kept 30 days. The request log row is
 *   written when the bind finishes, with its final status and cost.
 * - The work runs in the gateway process. A bind still pending after `BIND_TIMEOUT_MS` was cut off
 *   by a restart: `recoverInterruptedBinds` fails it and refunds it.
 */
import type { Context, MiddlewareHandler } from "hono";
import { sql } from "kysely";
import { background, bindRequest, bindSummary, RETENTION_DAYS } from "./activity";
import type { Database } from "./db";
import { refundDailyUnits } from "./db/counters";
import type { GatewayEnv, Upstream } from "./forward";
import { refundQuota, type QuotaReservation } from "./limits/quota";

export const MAX_PENDING_BINDS = 5;
/** Longest the gateway waits on the API for one bind (Bun's idle timeout for a sync `/select`). */
export const BIND_TIMEOUT_MS = 255_000;
/** Seconds a client should wait before polling again. */
export const POLL_AFTER_SECONDS = 2;

const DAY_MS = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_FOUND = "Bind not found (binds are kept 30 days)";

export interface BindRoutesOptions {
  getDb: () => Promise<Database>;
  upstream: Upstream;
  now?: () => Date;
}

/** `detail` of an API error body, if it is a string. */
function detailOf(text: string): string | null {
  try {
    const d = (JSON.parse(text) as { detail?: unknown }).detail;
    if (typeof d === "string") return d;
    if (d !== undefined) return JSON.stringify(d);
  } catch {
    // Not JSON.
  }
  return null;
}

export function bindRoutes(opts: BindRoutesOptions) {
  const now = opts.now ?? (() => new Date());

  /** A signed-in session or an API key; keyless callers use the synchronous `/select`. */
  const guard: MiddlewareHandler<GatewayEnv> = async (c, next) => {
    if (!c.get("userId") || c.get("isAnonymous") !== false) {
      return c.json({ detail: "Async binds need an account: sign in, or send your API key in x-api-key. Without one, use POST /api/select." }, 401);
    }
    c.header("cache-control", "no-store");
    return next();
  };

  /** A JSON object body, checked before anything is charged. The API validates its fields. */
  const validate: MiddlewareHandler<GatewayEnv> = async (c, next) => {
    const body = c.get("jsonBody");
    if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ detail: "The body must be a JSON object, as for POST /api/select" }, 422);
    return next();
  };

  const pendingCap: MiddlewareHandler<GatewayEnv> = async (c, next) => {
    const db = await opts.getDb();
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM bind_history WHERE user_id = ${c.get("userId")!} AND status = 'pending'`.execute(db);
    if (rows[0]!.n >= MAX_PENDING_BINDS) {
      c.header("Retry-After", String(POLL_AFTER_SECONDS));
      return c.json({ detail: `At most ${MAX_PENDING_BINDS} binds can be pending at once; wait for one to finish.` }, 429);
    }
    return next();
  };

  async function resolve(db: Database, a: { publicId: string; userId: string; keyId: string | null; keyStart: string | null; body: unknown; reservation?: QuotaReservation; at: Date }) {
    const started = performance.now();
    let status: number;
    let result: unknown = null;
    let error: string | null = null;
    try {
      const res = await opts.upstream("/select", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(a.body),
        userId: a.userId,
        signal: AbortSignal.timeout(BIND_TIMEOUT_MS),
      });
      status = res.status;
      const text = await res.text();
      if (res.ok) {
        try {
          result = JSON.parse(text);
        } catch {
          status = 502;
          error = "The API answered with something that is not JSON";
        }
      } else {
        error = detailOf(text) ?? `The API answered ${status}`;
      }
    } catch (e) {
      const timedOut = e instanceof DOMException && e.name === "TimeoutError";
      status = timedOut ? 504 : 502;
      error = timedOut ? `The API did not answer within ${BIND_TIMEOUT_MS / 1000} s` : "Upstream API unavailable";
    }

    const refund = status >= 500;
    const cost = a.reservation && !refund ? a.reservation.cost : 0;
    const done = result !== null;
    // Only a bind still pending: one failed by `recoverInterruptedBinds` meanwhile was already
    // refunded and logged.
    const updated = await sql`
      UPDATE bind_history SET
        status = ${done ? "done" : "failed"},
        finished_at = ${now()},
        response = ${done ? JSON.stringify(result) : null}::jsonb,
        summary = ${done ? JSON.stringify(bindSummary(result)) : null}::jsonb,
        error = ${error},
        cost = ${cost}
      WHERE public_id = ${a.publicId}::uuid AND status = 'pending'`.execute(db);
    if (!Number(updated.numAffectedRows ?? 0)) {
      const { rows } = await sql`SELECT 1 FROM bind_history WHERE public_id = ${a.publicId}::uuid`.execute(db);
      if (rows.length) return; // recovered
      // Deleted by its owner while pending: still refund and log it.
    }
    if (refund && a.reservation) {
      try {
        await refundQuota(db, a.reservation);
      } catch (e) {
        console.error("quota refund failed", e);
      }
    }
    await sql`
      INSERT INTO request_log (user_id, api_key_id, api_key_start, method, path, cost, status, duration_ms, at)
      VALUES (${a.userId}, ${a.keyId}, ${a.keyStart}, 'POST', '/binds', ${cost}, ${status}, ${Math.round(performance.now() - started)}, ${a.at})`.execute(db);
  }

  /** Mount after `quota`: the units are already reserved. */
  const submit = async (c: Context<GatewayEnv>) => {
    const db = await opts.getDb();
    const userId = c.get("userId")!;
    const body = c.get("jsonBody");
    const reservation = c.get("quota");
    const keyId = c.get("apiKeyId") ?? null;
    const keyStart = c.get("apiKeyStart") ?? null;
    const publicId = crypto.randomUUID();
    const at = now();
    await sql`
      INSERT INTO bind_history (public_id, status, user_id, api_key_id, api_key_start, cost, quota_day, request, summary, at)
      VALUES (${publicId}::uuid, 'pending', ${userId}, ${keyId}, ${keyStart}, ${reservation?.cost ?? 0}, ${reservation?.day ?? null},
              ${JSON.stringify(bindRequest(body))}::jsonb, NULL, ${at})`.execute(db);
    c.set("asyncBind", true);
    background(() => resolve(db, { publicId, userId, keyId, keyStart, body, reservation, at }));
    c.header("Location", `/api/binds/${publicId}`);
    c.header("Retry-After", String(POLL_AFTER_SECONDS));
    return c.json({ id: publicId, status: "pending" }, 202);
  };

  const get = async (c: Context<GatewayEnv>) => {
    const publicId = c.req.param("id") ?? "";
    if (!UUID.test(publicId)) return c.json({ detail: NOT_FOUND }, 404);
    const db = await opts.getDb();
    const since = new Date(now().getTime() - RETENTION_DAYS * DAY_MS);
    const { rows } = await sql<{ status: string; at: Date; finished_at: Date | null; response: unknown; error: string | null }>`
      SELECT status, at, finished_at, response, error FROM bind_history
      WHERE public_id = ${publicId}::uuid AND user_id = ${c.get("userId")!} AND at >= ${since}`.execute(db);
    const r = rows[0];
    if (!r) return c.json({ detail: NOT_FOUND }, 404);
    if (r.status === "pending") c.header("Retry-After", String(POLL_AFTER_SECONDS));
    const response = typeof r.response === "string" ? JSON.parse(r.response) : r.response;
    return c.json({
      id: publicId,
      status: r.status,
      submitted_at: new Date(r.at).toISOString(),
      finished_at: r.finished_at ? new Date(r.finished_at).toISOString() : null,
      ...(r.status === "done" ? { result: response } : {}),
      ...(r.status === "failed" ? { error: r.error } : {}),
    });
  };

  return { guard, validate, pendingCap, submit, get };
}

/**
 * Fails binds left pending by a gateway restart (older than `BIND_TIMEOUT_MS`) and refunds their
 * units. Run at startup and with the periodic purge (see index.ts).
 */
export async function recoverInterruptedBinds(db: Database, at: Date = new Date()): Promise<number> {
  const cutoff = new Date(at.getTime() - BIND_TIMEOUT_MS);
  const { rows } = await sql<{ user_id: string; api_key_id: string | null; api_key_start: string | null; quota_day: string | null; cost: number; at: Date }>`
    WITH stale AS (
      SELECT id, user_id, api_key_id, api_key_start, quota_day, cost, at FROM bind_history
      WHERE status = 'pending' AND at < ${cutoff} FOR UPDATE
    )
    UPDATE bind_history b
       SET status = 'failed', finished_at = ${at}, cost = 0,
           error = 'Interrupted: the gateway restarted before the bind finished. Its units were refunded.'
      FROM stale WHERE b.id = stale.id
    RETURNING stale.user_id, stale.api_key_id, stale.api_key_start, stale.quota_day, stale.cost, stale.at`.execute(db);
  for (const r of rows) {
    if (r.cost > 0 && r.quota_day) {
      await refundDailyUnits(db, { table: "quota_user_daily", key: r.user_id, day: r.quota_day, units: r.cost });
    }
    await sql`
      INSERT INTO request_log (user_id, api_key_id, api_key_start, method, path, cost, status, duration_ms, at)
      VALUES (${r.user_id}, ${r.api_key_id}, ${r.api_key_start}, 'POST', '/binds', 0, 504,
              ${Math.max(0, Math.round(at.getTime() - new Date(r.at).getTime()))}, ${r.at})`.execute(db);
  }
  return rows.length;
}
