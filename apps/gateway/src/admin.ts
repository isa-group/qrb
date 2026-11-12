/**
 * Admin API (`/api/admin/*`), for the website's /admin page.
 *
 * Who gets in (`guard`, every route), each failure a plain 404 so nothing reveals that the
 * routes exist:
 * 1. A browser session only (GitHub or ORCID sign-in): a request carrying `x-api-key` is
 *    refused, even an admin's key.
 * 2. The session user is an admin: `user.role` is `admin` (Better Auth's admin plugin) or the id
 *    is in `QRB_ADMIN_USER_IDS` (bootstrap).
 *
 * Changes (`POST`/`PUT`/`DELETE`) also need:
 * - Same origin: an `Origin` header equal to one of the auth trusted origins (CSRF).
 * - A recent sign-in: the session was created less than `STEP_UP_MS` ago, else 403 with
 *   `reauth: true` and the page sends the admin through OAuth again.
 * - Not on yourself: no self-ban, self-demotion or self-removal.
 * Each successful change writes a row to `admin_audit`.
 *
 * Better Auth's own admin routes (`/api/auth/admin/*`) are disabled (`ADMIN_DISABLED_PATHS`);
 * the actions here call the plugin in-process, which checks the admin role a second time.
 *
 * Responses never carry secrets: no key hashes, tokens or provider credentials. Session and
 * request IPs are truncated (/24 for IPv4, /48 for IPv6).
 */
import type { Context, MiddlewareHandler } from "hono";
import { sql } from "kysely";
import { deleteKeysOfUser } from "./auth/api-keys";
import { hasApiKey, IP_IDENTITY_PREFIX } from "./auth/anonymous";
import { ADMIN_ROLE, type GatewayAuth } from "./auth";
import { isPlaceholderEmail } from "./auth/email-policy";
import { parseIp } from "./client-ip";
import type { Database } from "./db";
import { utcDay } from "./db/counters";
import type { GatewayEnv } from "./forward";
import { clearQuotaOverride, getQuotaOverride, setQuotaOverride } from "./limits/override";

/** How recent the sign-in must be for a change. */
export const STEP_UP_MS = 15 * 60_000;

export const PAGE_SIZE = 50;
const MAX_DAILY_UNITS = 1_000_000;
const DAY_MS = 86_400_000;

/** `QRB_ADMIN_USER_IDS`, as also given to Better Auth's admin plugin (`auth/config.ts`). */
export function adminUserIdsFromEnv(env: Record<string, string | undefined> = process.env): string[] {
  return (env.QRB_ADMIN_USER_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

/** `203.0.113.7` -> `203.0.113.0/24`; IPv6 -> its /48. Null when not an address. */
export function truncateIp(raw: string | null | undefined): string | null {
  const ip = parseIp(raw ?? undefined);
  if (!ip) return null;
  if (ip.family === "ipv4") return ip.address.split(".").slice(0, 3).concat("0").join(".") + "/24";
  return ip.address.split(":").slice(0, 3).join(":") + "::/48";
}

export interface AdminOptions {
  getAuth: () => Promise<GatewayAuth>;
  getDb: () => Promise<Database>;
  /** Admins by id regardless of role (`QRB_ADMIN_USER_IDS`). */
  adminUserIds: readonly string[];
  /** Origins a change may come from (the auth trusted origins). */
  trustedOrigins: () => Promise<readonly string[]>;
  now?: () => Date;
}

const notFound = (c: Context<GatewayEnv>) => c.json({ detail: "Not Found" }, 404);
const isoOrNull = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());
const publicEmail = (email: string | null) => (email && !isPlaceholderEmail(email) ? email : null);

export function adminRoutes(opts: AdminOptions) {
  const now = opts.now ?? (() => new Date());
  const bootstrap = new Set(opts.adminUserIds);

  // ---------- guards ----------

  const guard: MiddlewareHandler<GatewayEnv> = async (c, next) => {
    if (hasApiKey(c)) return notFound(c);
    const userId = c.get("userId");
    if (!userId || c.get("isAnonymous") !== false || !c.get("sessionCreatedAt")) return notFound(c);
    if (c.get("sessionRole") !== ADMIN_ROLE && !bootstrap.has(userId)) return notFound(c);
    c.header("cache-control", "no-store");
    c.header("x-robots-tag", "noindex, nofollow");
    return next();
  };

  /** Mounted after `guard` on every change. */
  const change: MiddlewareHandler<GatewayEnv> = async (c, next) => {
    const origin = c.req.header("origin");
    if (!origin || !(await opts.trustedOrigins()).includes(origin)) {
      return c.json({ detail: "Cross-origin admin requests are refused" }, 403);
    }
    const signedIn = c.get("sessionCreatedAt")!;
    if (now().getTime() - signedIn.getTime() > STEP_UP_MS) {
      return c.json({ detail: "Sign in again to make changes (admin actions need a sign-in from the last 15 minutes).", reauth: true }, 403);
    }
    return next();
  };

  // ---------- helpers ----------

  const audit = async (c: Context<GatewayEnv>, action: string, target: string | null, details: Record<string, unknown> = {}) => {
    const db = await opts.getDb();
    await db
      .insertInto("admin_audit")
      .values({ actor_id: c.get("userId")!, action, target_user_id: target, details: JSON.stringify(details), ip: c.get("clientIp") ?? null })
      .execute();
  };

  const targetId = (c: Context<GatewayEnv>) => c.req.param("id") ?? "";

  /** The target account, or null (also for `ip:` identities, which are not accounts). */
  const findUser = async (db: Database, id: string) => {
    if (!id || id.startsWith(IP_IDENTITY_PREFIX)) return null;
    const { rows } = await sql<{ id: string; role: string | null }>`SELECT id, role FROM "user" WHERE id = ${id}`.execute(db);
    return rows[0] ?? null;
  };

  const readJson = async (c: Context<GatewayEnv>) => (await c.req.json().catch(() => null)) as Record<string, unknown> | null;

  // ---------- reads ----------

  /** `GET /api/admin/session`: who is signed in and until when changes are allowed. */
  const session = (c: Context<GatewayEnv>) => {
    const signedIn = c.get("sessionCreatedAt")!;
    return c.json({
      userId: c.get("userId"),
      signedInAt: signedIn.toISOString(),
      changesAllowedUntil: new Date(signedIn.getTime() + STEP_UP_MS).toISOString(),
    });
  };

  /** `GET /api/admin/users?q=&page=`: newest first, `PAGE_SIZE` per page. */
  const users = async (c: Context<GatewayEnv>) => {
    const db = await opts.getDb();
    const q = (c.req.query("q") ?? "").trim().slice(0, 100);
    const page = Math.max(0, Math.min(10_000, Number.parseInt(c.req.query("page") ?? "0", 10) || 0));
    const like = `%${q.replace(/[\\%_]/g, (m) => "\\" + m)}%`;
    const day = utcDay(now());
    const { rows } = await sql<{
      id: string;
      name: string;
      email: string;
      image: string | null;
      createdAt: Date;
      role: string | null;
      banned: boolean | null;
      banReason: string | null;
      banExpires: Date | null;
      providers: string[] | null;
      key_count: number;
      units_today: number | null;
      override_units: number | null;
      total: number;
    }>`
      SELECT u.id, u.name, u.email, u.image, u."createdAt", u.role, u.banned, u."banReason", u."banExpires",
        (SELECT array_agg(DISTINCT a."providerId") FROM account a WHERE a."userId" = u.id) AS providers,
        (SELECT count(*)::int FROM apikey k WHERE k."referenceId" = u.id) AS key_count,
        (SELECT q.units_used FROM quota_user_daily q WHERE q.user_id = u.id AND q.day = ${day}) AS units_today,
        o.daily_units AS override_units,
        count(*) OVER ()::int AS total
      FROM "user" u
      LEFT JOIN quota_override o ON o.user_id = u.id
      WHERE ${q} = '' OR u.name ILIKE ${like} OR u.email ILIKE ${like} OR u.id = ${q}
        OR EXISTS (SELECT 1 FROM account a WHERE a."userId" = u.id AND a."accountId" = ${q})
      ORDER BY u."createdAt" DESC, u.id
      LIMIT ${PAGE_SIZE} OFFSET ${page * PAGE_SIZE}`.execute(db);
    const total = rows[0]?.total ?? 0;
    return c.json({
      users: rows.map((u) => ({
        id: u.id,
        name: u.name,
        email: publicEmail(u.email),
        image: u.image,
        createdAt: isoOrNull(u.createdAt),
        role: u.role ?? "user",
        bootstrapAdmin: bootstrap.has(u.id),
        banned: !!u.banned,
        banReason: u.banned ? u.banReason : null,
        banExpires: u.banned ? isoOrNull(u.banExpires) : null,
        providers: (u.providers ?? []).sort(),
        keyCount: u.key_count,
        unitsToday: u.units_today ?? 0,
        dailyUnitsOverride: u.override_units,
      })),
      total,
      page,
      pageSize: PAGE_SIZE,
    });
  };

  /** `GET /api/admin/users/:id`: one account in detail. */
  const user = async (c: Context<GatewayEnv>) => {
    const db = await opts.getDb();
    const id = targetId(c);
    if (!(await findUser(db, id))) return c.json({ detail: "User not found" }, 404);
    const since = new Date(now().getTime() - 30 * DAY_MS);
    const [u, accounts, sessions, keys, daily, requests, binds, override] = await Promise.all([
      sql<Record<string, unknown>>`
        SELECT id, name, email, image, "createdAt", "updatedAt", role, banned, "banReason", "banExpires"
        FROM "user" WHERE id = ${id}`.execute(db),
      sql<{ providerId: string; accountId: string; createdAt: Date }>`
        SELECT "providerId", "accountId", "createdAt" FROM account WHERE "userId" = ${id} ORDER BY "createdAt"`.execute(db),
      sql<{ id: string; createdAt: Date; updatedAt: Date; expiresAt: Date; ipAddress: string | null; userAgent: string | null }>`
        SELECT id, "createdAt", "updatedAt", "expiresAt", "ipAddress", "userAgent" FROM session
        WHERE "userId" = ${id} AND "expiresAt" > now() ORDER BY "createdAt" DESC`.execute(db),
      sql<{ id: string; name: string | null; start: string | null; createdAt: Date }>`
        SELECT id, name, start, "createdAt" FROM apikey WHERE "referenceId" = ${id} ORDER BY "createdAt"`.execute(db),
      sql<{ day: string; units_used: number }>`
        SELECT day, units_used FROM quota_user_daily WHERE user_id = ${id} AND day >= ${utcDay(since)} ORDER BY day`.execute(db),
      sql<{ id: string; at: Date; method: string; path: string; cost: number; status: number; duration_ms: number; api_key_start: string | null }>`
        SELECT id, at, method, path, cost, status, duration_ms, api_key_start FROM request_log
        WHERE user_id = ${id} ORDER BY id DESC LIMIT ${PAGE_SIZE}`.execute(db),
      sql<{ total: number; pending: number }>`
        SELECT count(*)::int AS total, (count(*) FILTER (WHERE status = 'pending'))::int AS pending
        FROM bind_history WHERE user_id = ${id}`.execute(db),
      getQuotaOverride(db, id),
    ]);
    const row = u.rows[0]!;
    return c.json({
      id,
      name: row.name,
      email: publicEmail(row.email as string),
      image: row.image ?? null,
      createdAt: isoOrNull(row.createdAt),
      updatedAt: isoOrNull(row.updatedAt),
      role: (row.role as string | null) ?? "user",
      bootstrapAdmin: bootstrap.has(id),
      banned: !!row.banned,
      banReason: row.banned ? (row.banReason ?? null) : null,
      banExpires: row.banned ? isoOrNull(row.banExpires) : null,
      // Provider account ids are public profile ids (GitHub numeric id, ORCID iD).
      accounts: accounts.rows.map((a) => ({ provider: a.providerId, accountId: a.accountId, linkedAt: isoOrNull(a.createdAt) })),
      sessions: sessions.rows.map((s) => ({
        id: s.id,
        createdAt: isoOrNull(s.createdAt),
        lastSeenAt: isoOrNull(s.updatedAt),
        expiresAt: isoOrNull(s.expiresAt),
        network: truncateIp(s.ipAddress),
        userAgent: s.userAgent,
      })),
      keys: keys.rows.map((k) => ({ id: k.id, name: k.name, start: k.start, createdAt: isoOrNull(k.createdAt) })),
      daily: daily.rows.map((d) => ({ day: d.day, units: d.units_used })),
      requests: requests.rows.map((r) => ({
        id: String(r.id),
        at: isoOrNull(r.at),
        method: r.method,
        path: r.path,
        cost: r.cost,
        status: r.status,
        durationMs: r.duration_ms,
        apiKeyStart: r.api_key_start,
      })),
      binds: binds.rows[0] ?? { total: 0, pending: 0 },
      quotaOverride: override,
    });
  };

  /** `GET /api/admin/stats`: accounts and usage over the last 30 days. */
  const stats = async (c: Context<GatewayEnv>) => {
    const db = await opts.getDb();
    const at = now();
    const since = new Date(at.getTime() - 29 * DAY_MS);
    const sinceDay = utcDay(since);
    const [totals, signups, units, requests] = await Promise.all([
      sql<{ users: number; admins: number; banned: number; keys: number; overrides: number; pending_binds: number }>`
        SELECT (SELECT count(*)::int FROM "user") AS users,
          (SELECT count(*)::int FROM "user" WHERE role = ${ADMIN_ROLE}) AS admins,
          (SELECT count(*)::int FROM "user" WHERE banned) AS banned,
          (SELECT count(*)::int FROM apikey) AS keys,
          (SELECT count(*)::int FROM quota_override) AS overrides,
          (SELECT count(*)::int FROM bind_history WHERE status = 'pending') AS pending_binds`.execute(db),
      sql<{ day: string; n: number }>`
        SELECT to_char("createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, count(*)::int AS n
        FROM "user" WHERE "createdAt" >= ${since} GROUP BY 1`.execute(db),
      sql<{ day: string; anonymous: number; signed_in: number; active: number }>`
        SELECT day,
          coalesce(sum(units_used) FILTER (WHERE user_id LIKE 'ip:%'), 0)::int AS anonymous,
          coalesce(sum(units_used) FILTER (WHERE user_id NOT LIKE 'ip:%'), 0)::int AS signed_in,
          (count(*) FILTER (WHERE user_id NOT LIKE 'ip:%'))::int AS active
        FROM quota_user_daily WHERE day >= ${sinceDay} GROUP BY day`.execute(db),
      sql<{ day: string; requests: number; rejected: number; errors: number }>`
        SELECT to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, count(*)::int AS requests,
          (count(*) FILTER (WHERE status = 429))::int AS rejected,
          (count(*) FILTER (WHERE status >= 500))::int AS errors
        FROM request_log WHERE at >= ${new Date(`${sinceDay}T00:00:00Z`)} GROUP BY 1`.execute(db),
    ]);
    const by = <T extends { day: string }>(rows: T[]) => new Map(rows.map((r) => [r.day, r]));
    const s = by(signups.rows);
    const u = by(units.rows);
    const r = by(requests.rows);
    const days = Array.from({ length: 30 }, (_, i) => {
      const day = utcDay(new Date(since.getTime() + i * DAY_MS));
      return {
        day,
        signups: s.get(day)?.n ?? 0,
        unitsAnonymous: u.get(day)?.anonymous ?? 0,
        unitsSignedIn: u.get(day)?.signed_in ?? 0,
        activeAccounts: u.get(day)?.active ?? 0,
        // Signed-in counted requests only (keyless callers are not logged).
        requests: r.get(day)?.requests ?? 0,
        rejected: r.get(day)?.rejected ?? 0,
        errors: r.get(day)?.errors ?? 0,
      };
    });
    const t = totals.rows[0]!;
    return c.json({
      totals: { users: t.users, admins: t.admins, banned: t.banned, apiKeys: t.keys, quotaOverrides: t.overrides, pendingBinds: t.pending_binds },
      days,
    });
  };

  /**
   * `GET /api/admin/catalog`: how fresh the stored catalog is (the poller's tables, owned by
   * qrb-store in the same database). `available: false` when those tables do not exist.
   */
  const catalog = async (c: Context<GatewayEnv>) => {
    const db = await opts.getDb();
    const { rows: present } = await sql<{ status: string | null; resource: string | null }>`
      SELECT to_regclass('catalog_status')::text AS status, to_regclass('catalog_resource')::text AS resource`.execute(db);
    if (!present[0]?.status || !present[0]?.resource) return c.json({ available: false, statusFetchedAt: null, resources: [] });
    const [status, resources] = await Promise.all([
      sql<{ fetched_at: Date; origin: string }>`
        SELECT fetched_at, origin FROM catalog_status ORDER BY fetched_at DESC LIMIT 1`.execute(db),
      sql<{ provider_id: string; resource_id: string; checked_at: Date; fetched_at: Date; calibrated_at: Date | null; origin: string }>`
        SELECT DISTINCT ON (provider_id, resource_id) provider_id, resource_id, checked_at, fetched_at, calibrated_at, origin
        FROM catalog_resource ORDER BY provider_id, resource_id, checked_at DESC`.execute(db),
    ]);
    return c.json({
      available: true,
      statusFetchedAt: isoOrNull(status.rows[0]?.fetched_at),
      statusOrigin: status.rows[0]?.origin ?? null,
      resources: resources.rows.map((r) => ({
        provider: r.provider_id,
        resource: r.resource_id,
        checkedAt: isoOrNull(r.checked_at),
        fetchedAt: isoOrNull(r.fetched_at),
        calibratedAt: isoOrNull(r.calibrated_at),
        origin: r.origin,
      })),
    });
  };

  /** `GET /api/admin/audit?before=<id>&user=<id>`: newest first. */
  const auditLog = async (c: Context<GatewayEnv>) => {
    const db = await opts.getDb();
    const before = c.req.query("before");
    const target = c.req.query("user");
    let q = db
      .selectFrom("admin_audit as a")
      .leftJoin(sql<{ id: string; name: string }>`"user"`.as("actor"), "actor.id", "a.actor_id")
      .leftJoin(sql<{ id: string; name: string }>`"user"`.as("target"), "target.id", "a.target_user_id")
      .select(["a.id", "a.actor_id", "a.action", "a.target_user_id", "a.details", "a.ip", "a.at", "actor.name as actor_name", "target.name as target_name"])
      .orderBy("a.id", "desc")
      .limit(PAGE_SIZE + 1);
    if (before && /^\d+$/.test(before)) q = q.where("a.id", "<", before);
    if (target) q = q.where("a.target_user_id", "=", target);
    const rows = await q.execute();
    const page = rows.slice(0, PAGE_SIZE);
    return c.json({
      entries: page.map((r) => ({
        id: String(r.id),
        at: isoOrNull(r.at),
        actor: { id: r.actor_id, name: r.actor_name ?? null },
        action: r.action,
        target: r.target_user_id ? { id: r.target_user_id, name: r.target_name ?? null } : null,
        details: r.details,
        ip: r.ip,
      })),
      next: rows.length > PAGE_SIZE ? String(page[page.length - 1]!.id) : null,
    });
  };

  // ---------- changes ----------

  /** Runs a Better Auth admin call; its errors become `{detail}` with the plugin's status. */
  const plugin = async (c: Context<GatewayEnv>, run: (auth: GatewayAuth, headers: Headers) => Promise<unknown>) => {
    const auth = await opts.getAuth();
    try {
      await run(auth, c.req.raw.headers);
      return null;
    } catch (e) {
      const err = e as { statusCode?: number; body?: { message?: string } };
      if (typeof err.statusCode === "number" && err.statusCode >= 400 && err.statusCode < 500) {
        return c.json({ detail: err.body?.message ?? "Refused" }, err.statusCode as 400);
      }
      throw e;
    }
  };

  const notYourself = (c: Context<GatewayEnv>, what: string) =>
    targetId(c) === c.get("userId") ? c.json({ detail: `You cannot ${what} your own account` }, 400) : null;

  /** `POST /api/admin/users/:id/ban {reason, days?}`: ends their sessions and deletes their API keys. */
  const ban = async (c: Context<GatewayEnv>) => {
    const self = notYourself(c, "ban");
    if (self) return self;
    const db = await opts.getDb();
    const id = targetId(c);
    if (!(await findUser(db, id))) return c.json({ detail: "User not found" }, 404);
    const body = await readJson(c);
    const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
    if (!reason || reason.length > 200) return c.json({ detail: "reason must be 1 to 200 characters" }, 400);
    const days = body?.days;
    if (days != null && (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > 3650)) {
      return c.json({ detail: "days must be a whole number from 1 to 3650, or omitted for a permanent ban" }, 400);
    }
    const refused = await plugin(c, (auth, headers) =>
      auth.api.banUser({ headers, body: { userId: id, banReason: reason, ...(days ? { banExpiresIn: days * 86_400 } : {}) } }),
    );
    if (refused) return refused;
    await deleteKeysOfUser(db)({ id });
    await audit(c, "user.ban", id, { reason, days: days ?? null });
    return c.json({ success: true });
  };

  const unban = async (c: Context<GatewayEnv>) => {
    const db = await opts.getDb();
    const id = targetId(c);
    if (!(await findUser(db, id))) return c.json({ detail: "User not found" }, 404);
    const refused = await plugin(c, (auth, headers) => auth.api.unbanUser({ headers, body: { userId: id } }));
    if (refused) return refused;
    await audit(c, "user.unban", id);
    return c.json({ success: true });
  };

  /** `POST /api/admin/users/:id/revoke-sessions`: signs the account out everywhere. */
  const revokeSessions = async (c: Context<GatewayEnv>) => {
    const self = notYourself(c, "sign out");
    if (self) return self;
    const db = await opts.getDb();
    const id = targetId(c);
    if (!(await findUser(db, id))) return c.json({ detail: "User not found" }, 404);
    const refused = await plugin(c, (auth, headers) => auth.api.revokeUserSessions({ headers, body: { userId: id } }));
    if (refused) return refused;
    await audit(c, "user.revoke_sessions", id);
    return c.json({ success: true });
  };

  /** `DELETE /api/admin/users/:id/keys/:keyId`. */
  const revokeKey = async (c: Context<GatewayEnv>) => {
    const db = await opts.getDb();
    const id = targetId(c);
    const keyId = c.req.param("keyId") ?? "";
    const { rows } = await sql<{ start: string | null }>`
      DELETE FROM apikey WHERE id = ${keyId} AND "referenceId" = ${id} RETURNING start`.execute(db);
    if (!rows.length) return c.json({ detail: "API key not found" }, 404);
    await audit(c, "key.revoke", id, { keyId, start: rows[0]!.start });
    return c.json({ success: true });
  };

  /** `PUT /api/admin/users/:id/quota {dailyUnits, reason}`. */
  const putQuota = async (c: Context<GatewayEnv>) => {
    const db = await opts.getDb();
    const id = targetId(c);
    if (!(await findUser(db, id))) return c.json({ detail: "User not found" }, 404);
    const body = await readJson(c);
    const units = body?.dailyUnits;
    const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
    if (typeof units !== "number" || !Number.isInteger(units) || units < 0 || units > MAX_DAILY_UNITS) {
      return c.json({ detail: `dailyUnits must be a whole number from 0 to ${MAX_DAILY_UNITS}` }, 400);
    }
    if (!reason || reason.length > 200) return c.json({ detail: "reason must be 1 to 200 characters" }, 400);
    const before = await getQuotaOverride(db, id);
    await setQuotaOverride(db, { userId: id, dailyUnits: units, reason, setBy: c.get("userId")! });
    await audit(c, "quota.set", id, { dailyUnits: units, reason, previous: before?.dailyUnits ?? null });
    return c.json({ success: true });
  };

  const deleteQuota = async (c: Context<GatewayEnv>) => {
    const db = await opts.getDb();
    const id = targetId(c);
    const before = await getQuotaOverride(db, id);
    if (!before || !(await clearQuotaOverride(db, id))) return c.json({ detail: "No quota override for this user" }, 404);
    await audit(c, "quota.clear", id, { previous: before.dailyUnits });
    return c.json({ success: true });
  };

  /** `POST /api/admin/users/:id/role {role: "admin" | "user"}`. */
  const setRole = async (c: Context<GatewayEnv>) => {
    const self = notYourself(c, "change the role of");
    if (self) return self;
    const db = await opts.getDb();
    const id = targetId(c);
    const target = await findUser(db, id);
    if (!target) return c.json({ detail: "User not found" }, 404);
    const body = await readJson(c);
    const role = body?.role;
    if (role !== ADMIN_ROLE && role !== "user") return c.json({ detail: 'role must be "admin" or "user"' }, 400);
    const refused = await plugin(c, (auth, headers) => auth.api.setRole({ headers, body: { userId: id, role } }));
    if (refused) return refused;
    await audit(c, "user.set_role", id, { role, previous: target.role ?? "user" });
    return c.json({ success: true, ...(role === "user" && bootstrap.has(id) ? { note: "Still an admin through QRB_ADMIN_USER_IDS" } : {}) });
  };

  /**
   * `DELETE /api/admin/users/:id {confirm: <user id>}`: deletes the account with its keys,
   * activity and override (`databaseHooks.user.delete`). Cannot be undone.
   */
  const remove = async (c: Context<GatewayEnv>) => {
    const self = notYourself(c, "delete");
    if (self) return self;
    const db = await opts.getDb();
    const id = targetId(c);
    const { rows } = await sql<{ name: string }>`SELECT name FROM "user" WHERE id = ${id}`.execute(db);
    if (!rows.length || id.startsWith(IP_IDENTITY_PREFIX)) return c.json({ detail: "User not found" }, 404);
    const body = await readJson(c);
    if (body?.confirm !== id) return c.json({ detail: "Confirm by sending the user id as confirm" }, 400);
    const refused = await plugin(c, (auth, headers) => auth.api.removeUser({ headers, body: { userId: id } }));
    if (refused) return refused;
    await audit(c, "user.remove", id, { name: rows[0]!.name });
    return c.json({ success: true });
  };

  return {
    guard,
    change,
    session,
    users,
    user,
    stats,
    catalog,
    audit: auditLog,
    ban,
    unban,
    revokeSessions,
    revokeKey,
    putQuota,
    deleteQuota,
    setRole,
    remove,
  };
}

/** Mounts the admin API on `app` (see module doc). `before` runs first on every route (rate limit, session). */
export function mountAdmin(
  app: { get: Function; post: Function; put: Function; delete: Function },
  before: readonly MiddlewareHandler<GatewayEnv>[],
  opts: AdminOptions,
): void {
  const a = adminRoutes(opts);
  const read = [...before, a.guard];
  const write = [...read, a.change];
  const base = "/api/admin";
  app.get(`${base}/session`, ...read, a.session);
  app.get(`${base}/users`, ...read, a.users);
  app.get(`${base}/users/:id`, ...read, a.user);
  app.get(`${base}/stats`, ...read, a.stats);
  app.get(`${base}/catalog`, ...read, a.catalog);
  app.get(`${base}/audit`, ...read, a.audit);
  app.post(`${base}/users/:id/ban`, ...write, a.ban);
  app.post(`${base}/users/:id/unban`, ...write, a.unban);
  app.post(`${base}/users/:id/revoke-sessions`, ...write, a.revokeSessions);
  app.delete(`${base}/users/:id/keys/:keyId`, ...write, a.revokeKey);
  app.put(`${base}/users/:id/quota`, ...write, a.putQuota);
  app.delete(`${base}/users/:id/quota`, ...write, a.deleteQuota);
  app.post(`${base}/users/:id/role`, ...write, a.setRole);
  app.delete(`${base}/users/:id`, ...write, a.remove);
}
