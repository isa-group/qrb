/**
 * Account activity: what a signed-in user's browser session and API key used, and what they
 * bound, for the website's Account page. Kept `RETENTION_DAYS` days. Keyless callers (identified
 * by IP) are never recorded.
 *
 * Recording (`recordActivity`, mounted after identity and before `burst` and `quota` on counted
 * routes, so it sees their 429s and the final, possibly refunded, cost):
 * - `request_log`: one row per counted request (one whose kind costs units): method, path,
 *   source (key or browser), cost after any refund, status and duration.
 * - `bind_history`: for `POST /select` answering 200, the request as sent and a summary of the
 *   answer (winners, candidate count, feasibility, data source). The response is teed: the
 *   caller gets its copy at once and the summary is parsed and stored in the background.
 *
 * Reading (session only, never an API key; `activityRoutes`): daily totals by source, the request
 * log and the bind history (paged by id, or the full 30 days as CSV), one bind with its circuit
 * (to reopen it in /bind), and deleting one bind or all of them.
 */
import type { Context, MiddlewareHandler, Next } from "hono";
import { sql } from "kysely";
import type { Database } from "./db";
import type { GatewayEnv } from "./forward";
import { hasApiKey } from "./auth/anonymous";
import type { LimitsConfig } from "./limits/config";
import { requestCost } from "./limits/quota";

export const RETENTION_DAYS = 30;
export const PAGE_SIZE = 50;
const DAY_MS = 86_400_000;

// ---------- background writes ----------

const pending = new Set<Promise<unknown>>();

export function background(work: () => Promise<unknown>): void {
  const p = work()
    .catch((e) => console.error("activity write failed", e))
    .finally(() => pending.delete(p));
  pending.add(p);
}

/** Resolves when every background activity write started so far has finished (tests, shutdown). */
export async function activityIdle(): Promise<void> {
  while (pending.size) await Promise.all([...pending]);
}

/** Deletes activity older than the retention period. Run periodically (see index.ts). */
export async function purgeActivity(db: Database, now: Date = new Date()): Promise<void> {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * DAY_MS);
  await sql`DELETE FROM request_log WHERE at < ${cutoff}`.execute(db);
  await sql`DELETE FROM bind_history WHERE at < ${cutoff}`.execute(db);
}

/** Better Auth `databaseHooks.user.delete.after`: a deleted user's activity goes with them. */
export function deleteActivityOfUser(db: Database) {
  return async (user: { id: string }): Promise<void> => {
    await sql`DELETE FROM request_log WHERE user_id = ${user.id}`.execute(db);
    await sql`DELETE FROM bind_history WHERE user_id = ${user.id}`.execute(db);
  };
}

// ---------- recording ----------

interface Candidate {
  candidate_id?: unknown;
  name?: unknown;
  provider_id?: unknown;
}

/** What the Account page shows of a bind, from the `/select` answer. */
export function bindSummary(body: unknown) {
  const b = (body ?? {}) as {
    result?: { feasibility?: unknown; solutions?: { binding?: Record<string, unknown> }[]; provenance?: { engine_id?: unknown } };
    candidates?: Candidate[];
    source?: { mode?: unknown; as_of?: unknown; cache_hit?: unknown };
  };
  const candidates = Array.isArray(b.candidates) ? b.candidates : [];
  const byId = new Map(candidates.map((c) => [String(c.candidate_id), c]));
  const solutions = Array.isArray(b.result?.solutions) ? b.result!.solutions! : [];
  const ids = [...new Set(solutions.flatMap((s) => Object.values(s.binding ?? {}).map(String)))];
  return {
    feasibility: typeof b.result?.feasibility === "string" ? b.result.feasibility : null,
    solutions: solutions.length,
    candidates: candidates.length,
    winners: ids.map((id) => {
      const c = byId.get(id);
      return { id, name: typeof c?.name === "string" ? c.name : id, provider: typeof c?.provider_id === "string" ? c.provider_id : null };
    }),
    engine: typeof b.result?.provenance?.engine_id === "string" ? b.result.provenance.engine_id : null,
    source: {
      mode: typeof b.source?.mode === "string" ? b.source.mode : null,
      as_of: typeof b.source?.as_of === "string" ? b.source.as_of : null,
      cache_hit: typeof b.source?.cache_hit === "boolean" ? b.source.cache_hit : null,
    },
  };
}

/** The request as the Account page and /bind need it back; nothing else from the body is kept. */
export function bindRequest(body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>;
  return {
    circuit_qasm: typeof b.circuit_qasm === "string" ? b.circuit_qasm : "",
    preferences: b.preferences && typeof b.preferences === "object" ? b.preferences : {},
    shots: typeof b.shots === "number" ? b.shots : 1024,
    live: typeof b.live === "boolean" ? b.live : true,
    force_refresh: typeof b.force_refresh === "boolean" ? b.force_refresh : true,
  };
}

export interface ActivityOptions {
  getDb: () => Promise<Database>;
  config: LimitsConfig;
  /** The gateway clock (the quota day uses it too), injectable for tests. */
  now?: () => Date;
}

export function recordActivity(opts: ActivityOptions): MiddlewareHandler<GatewayEnv> {
  const clock = opts.now ?? (() => new Date());
  return async (c: Context<GatewayEnv>, next: Next) => {
    const userId = c.get("userId");
    if (!userId || c.get("isAnonymous") !== false || requestCost(c, opts.config) === 0) return next();
    const at = clock();
    const started = performance.now();
    await next();
    // An accepted async bind writes its own row when it finishes (final status and cost).
    if (c.get("asyncBind")) return;
    const duration = Math.round(performance.now() - started);
    const reservation = c.get("quota");
    const cost = reservation && !reservation.refunded ? reservation.cost : 0;
    const keyId = c.get("apiKeyId") ?? null;
    const keyStart = c.get("apiKeyStart") ?? null;
    const method = c.req.method;
    const path = new URL(c.req.url).pathname.replace(/^\/api/, "");
    const status = c.res.status;
    const db = await opts.getDb();

    background(() =>
      sql`INSERT INTO request_log (user_id, api_key_id, api_key_start, method, path, cost, status, duration_ms, at)
          VALUES (${userId}, ${keyId}, ${keyStart}, ${method}, ${path}, ${cost}, ${status}, ${duration}, ${at})`.execute(db),
    );

    if (method !== "POST" || path !== "/select" || status !== 200 || !c.res.body) return;
    const request = bindRequest(c.get("jsonBody"));
    const [mine, theirs] = c.res.body.tee();
    c.res = new Response(theirs, { status: c.res.status, statusText: c.res.statusText, headers: c.res.headers });
    background(async () => {
      const summary = bindSummary(await new Response(mine).json());
      await sql`INSERT INTO bind_history (user_id, api_key_id, api_key_start, cost, request, summary, at)
                VALUES (${userId}, ${keyId}, ${keyStart}, ${cost}, ${JSON.stringify(request)}::jsonb, ${JSON.stringify(summary)}::jsonb, ${at})`.execute(db);
    });
  };
}

// ---------- reading ----------

const iso = (d: Date | string) => new Date(d).toISOString();
const utcDay = (d: Date) => d.toISOString().slice(0, 10);

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const csv = (header: string[], rows: unknown[][]) => [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";

function csvResponse(c: Context, name: string, body: string, now: Date) {
  const from = utcDay(new Date(now.getTime() - (RETENTION_DAYS - 1) * DAY_MS));
  c.header("content-type", "text/csv; charset=utf-8");
  c.header("content-disposition", `attachment; filename="qrb-${name}-${from}-to-${utcDay(now)}.csv"`);
  return c.body(body);
}

/** `?before=<id>` cursor: a positive integer id, else none. */
function cursor(c: Context): string | null {
  const v = c.req.query("before");
  return v && /^\d{1,18}$/.test(v) ? v : null;
}

interface RequestRow {
  id: string;
  api_key_id: string | null;
  api_key_start: string | null;
  method: string;
  path: string;
  cost: number;
  status: number;
  duration_ms: number;
  at: Date;
}
interface BindRow {
  id: string;
  api_key_id: string | null;
  api_key_start: string | null;
  cost: number;
  request: ReturnType<typeof bindRequest>;
  summary: ReturnType<typeof bindSummary> | null;
  status: "pending" | "done" | "failed";
  error: string | null;
  at: Date;
}

/** A bind row without the stored response (the list and the reopen need only the summary). */
const BIND_COLUMNS = sql.raw("id, api_key_id, api_key_start, cost, request, summary, status, error, at");

const source = (r: { api_key_id: string | null; api_key_start: string | null }) =>
  r.api_key_id ? { source: "key" as const, apiKeyStart: r.api_key_start } : { source: "browser" as const, apiKeyStart: null };

const parsed = <T>(v: T | string): T => (typeof v === "string" ? (JSON.parse(v) as T) : v);

/** A bind as listed: no circuit (the list stays small); `preferences` and `shots` are kept. */
function listedBind(r: BindRow) {
  const request = parsed(r.request);
  return {
    id: String(r.id),
    at: iso(r.at),
    ...source(r),
    cost: r.cost,
    preferences: request.preferences,
    shots: request.shots,
    live: request.live,
    status: r.status,
    error: r.error,
    summary: r.summary === null ? null : parsed(r.summary),
  };
}

const prefsText = (p: Record<string, unknown>) => {
  if (typeof p.preset === "string") return { preset: p.preset, weights: "" };
  const w = p.weights && typeof p.weights === "object" ? (p.weights as Record<string, unknown>) : {};
  return {
    preset: "",
    weights: Object.entries(w)
      .map(([k, v]) => `${k}=${v}`)
      .join(" "),
  };
};

export interface ActivityRouteOptions {
  getDb: () => Promise<Database>;
  now?: () => Date;
}

export function activityRoutes(opts: ActivityRouteOptions) {
  const now = opts.now ?? (() => new Date());
  const since = () => new Date(now().getTime() - RETENTION_DAYS * DAY_MS);

  /** Session of a signed-in user only: an API key cannot read or delete history. */
  const guard: MiddlewareHandler<GatewayEnv> = async (c, next) => {
    if (hasApiKey(c) || !c.get("userId") || c.get("isAnonymous") !== false) return c.json({ detail: "Sign in to see your activity" }, 401);
    c.header("cache-control", "no-store");
    return next();
  };

  /**
   * Units per UTC day by source. An async bind still resolving has been charged but has no request
   * log row yet: its units count on its day and source too (and as `pending`), so a day's key plus
   * browser equals what the quota counter took.
   */
  const daily = async (c: Context<GatewayEnv>) => {
    const db = await opts.getDb();
    const userId = c.get("userId")!;
    const { rows } = await sql<{ day: string; key: number; browser: number; pending: number }>`
      SELECT day, sum(key)::int AS key, sum(browser)::int AS browser, sum(pending)::int AS pending FROM (
        SELECT to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
               coalesce(sum(cost) FILTER (WHERE api_key_id IS NOT NULL), 0) AS key,
               coalesce(sum(cost) FILTER (WHERE api_key_id IS NULL), 0) AS browser,
               0 AS pending
        FROM request_log WHERE user_id = ${userId} AND at >= ${since()}
        GROUP BY 1
        UNION ALL
        SELECT quota_day AS day,
               coalesce(sum(cost) FILTER (WHERE api_key_id IS NOT NULL), 0) AS key,
               coalesce(sum(cost) FILTER (WHERE api_key_id IS NULL), 0) AS browser,
               coalesce(sum(cost), 0) AS pending
        FROM bind_history WHERE user_id = ${userId} AND status = 'pending' AND quota_day IS NOT NULL
        GROUP BY 1
      ) t GROUP BY day`.execute(db);
    const byDay = new Map(rows.map((r) => [r.day, r]));
    const today = now();
    const days = Array.from({ length: RETENTION_DAYS }, (_, i) => {
      const day = utcDay(new Date(today.getTime() - (RETENTION_DAYS - 1 - i) * DAY_MS));
      const r = byDay.get(day);
      return { day, key: r?.key ?? 0, browser: r?.browser ?? 0, pending: r?.pending ?? 0 };
    });
    return c.json({ days });
  };

  const requests = async (c: Context<GatewayEnv>) => {
    const db = await opts.getDb();
    const userId = c.get("userId")!;
    if (c.req.query("format") === "csv") {
      const { rows } = await sql<RequestRow>`
        SELECT * FROM request_log WHERE user_id = ${userId} AND at >= ${since()} ORDER BY id DESC`.execute(db);
      return csvResponse(
        c,
        "requests",
        csv(
          ["time_utc", "method", "endpoint", "source", "api_key", "units", "status", "duration_ms"],
          rows.map((r) => [iso(r.at), r.method, r.path, source(r).source, r.api_key_start ?? "", r.cost, r.status, r.duration_ms]),
        ),
        now(),
      );
    }
    const before = cursor(c);
    const { rows } = await sql<RequestRow>`
      SELECT * FROM request_log WHERE user_id = ${userId} AND at >= ${since()}
        ${before ? sql`AND id < ${before}::bigint` : sql``}
      ORDER BY id DESC LIMIT ${PAGE_SIZE + 1}`.execute(db);
    const page = rows.slice(0, PAGE_SIZE);
    return c.json({
      requests: page.map((r) => ({
        id: String(r.id),
        at: iso(r.at),
        ...source(r),
        method: r.method,
        path: r.path,
        cost: r.cost,
        status: r.status,
        durationMs: r.duration_ms,
      })),
      next: rows.length > PAGE_SIZE ? String(page.at(-1)!.id) : null,
    });
  };

  const binds = async (c: Context<GatewayEnv>) => {
    const db = await opts.getDb();
    const userId = c.get("userId")!;
    if (c.req.query("format") === "csv") {
      const { rows } = await sql<BindRow>`
        SELECT ${BIND_COLUMNS} FROM bind_history WHERE user_id = ${userId} AND at >= ${since()} ORDER BY id DESC`.execute(db);
      return csvResponse(
        c,
        "binds",
        csv(
          ["time_utc", "status", "source", "api_key", "winners", "providers", "feasibility", "solutions", "candidates", "preset", "weights", "shots", "data", "data_as_of", "cache_hit", "units"],
          rows.map((raw) => {
            const r = listedBind(raw);
            const p = prefsText((r.preferences ?? {}) as Record<string, unknown>);
            const s = r.summary;
            return [
              r.at,
              r.status,
              r.source,
              r.apiKeyStart ?? "",
              s?.winners.map((w) => w.id).join(" ") ?? "",
              s?.winners.map((w) => w.provider ?? "").join(" ") ?? "",
              s?.feasibility ?? "",
              s?.solutions ?? "",
              s?.candidates ?? "",
              p.preset,
              p.weights,
              r.shots,
              s?.source.mode ?? "",
              s?.source.as_of ?? "",
              s?.source.cache_hit ?? "",
              r.cost,
            ];
          }),
        ),
        now(),
      );
    }
    const before = cursor(c);
    const { rows } = await sql<BindRow>`
      SELECT ${BIND_COLUMNS} FROM bind_history WHERE user_id = ${userId} AND at >= ${since()}
        ${before ? sql`AND id < ${before}::bigint` : sql``}
      ORDER BY id DESC LIMIT ${PAGE_SIZE + 1}`.execute(db);
    const page = rows.slice(0, PAGE_SIZE);
    return c.json({ binds: page.map(listedBind), next: rows.length > PAGE_SIZE ? String(page.at(-1)!.id) : null });
  };

  const id = (c: Context) => {
    const v = c.req.param("id") ?? "";
    return /^\d{1,18}$/.test(v) ? v : null;
  };

  const bind = async (c: Context<GatewayEnv>) => {
    const bindId = id(c);
    if (!bindId) return c.json({ detail: "This bind is no longer stored (binds are kept 30 days)" }, 404);
    const db = await opts.getDb();
    const { rows } = await sql<BindRow>`
      SELECT ${BIND_COLUMNS} FROM bind_history WHERE id = ${bindId}::bigint AND user_id = ${c.get("userId")!} AND at >= ${since()}`.execute(db);
    const r = rows[0];
    if (!r) return c.json({ detail: "This bind is no longer stored (binds are kept 30 days)" }, 404);
    return c.json({ ...listedBind(r), request: parsed(r.request) });
  };

  const removeOne = async (c: Context<GatewayEnv>) => {
    const bindId = id(c);
    const db = await opts.getDb();
    const res = bindId
      ? await sql`DELETE FROM bind_history WHERE id = ${bindId}::bigint AND user_id = ${c.get("userId")!}`.execute(db)
      : { numAffectedRows: 0n };
    if (!Number(res.numAffectedRows ?? 0)) return c.json({ detail: "Bind not found" }, 404);
    return c.json({ success: true });
  };

  const removeAll = async (c: Context<GatewayEnv>) => {
    const db = await opts.getDb();
    const res = await sql`DELETE FROM bind_history WHERE user_id = ${c.get("userId")!}`.execute(db);
    return c.json({ deleted: Number(res.numAffectedRows ?? 0) });
  };

  return { guard, daily, requests, binds, bind, removeOne, removeAll };
}
