"use client";

/**
 * The gateway's admin API (`/api/admin/*`, apps/gateway/src/admin.ts). Only admins get answers;
 * everyone else gets 404. Changes need a sign-in from the last 15 minutes: they fail with 403 and
 * `reauth`, and the page offers to sign in again.
 */
import { call, RequestError } from "./auth";

export interface AdminSession {
  userId: string;
  signedInAt: string;
  changesAllowedUntil: string;
}

export interface AdminUserRow {
  id: string;
  name: string;
  email: string | null;
  image: string | null;
  createdAt: string;
  role: string;
  bootstrapAdmin: boolean;
  banned: boolean;
  banReason: string | null;
  banExpires: string | null;
  providers: string[];
  keyCount: number;
  unitsToday: number;
  dailyUnitsOverride: number | null;
}

export interface AdminUserDetail extends Omit<AdminUserRow, "providers" | "keyCount" | "unitsToday" | "dailyUnitsOverride"> {
  updatedAt: string;
  accounts: { provider: string; accountId: string; linkedAt: string }[];
  sessions: { id: string; createdAt: string; lastSeenAt: string; expiresAt: string; network: string | null; userAgent: string | null }[];
  keys: { id: string; name: string | null; start: string | null; createdAt: string }[];
  daily: { day: string; units: number }[];
  requests: { id: string; at: string; method: string; path: string; cost: number; status: number; durationMs: number; apiKeyStart: string | null }[];
  binds: { total: number; pending: number };
  quotaOverride: { dailyUnits: number; reason: string; setBy: string; setAt: string } | null;
}

export interface AdminStats {
  totals: { users: number; admins: number; banned: number; apiKeys: number; quotaOverrides: number; pendingBinds: number };
  days: {
    day: string;
    signups: number;
    unitsAnonymous: number;
    unitsSignedIn: number;
    activeAccounts: number;
    requests: number;
    rejected: number;
    errors: number;
  }[];
}

export interface AdminCatalog {
  available: boolean;
  statusFetchedAt: string | null;
  statusOrigin?: string | null;
  resources: { provider: string; resource: string; checkedAt: string; fetchedAt: string; calibratedAt: string | null; origin: string }[];
}

export interface AuditEntry {
  id: string;
  at: string;
  actor: { id: string; name: string | null };
  action: string;
  target: { id: string; name: string | null } | null;
  details: Record<string, unknown>;
  ip: string | null;
}

const get = <T>(path: string) => call<T>(`/admin${path}`, { cache: "no-store" });
const send = <T = { success: boolean }>(method: string, path: string, body?: unknown) =>
  call<T>(`/admin${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });
const user = (id: string) => `/users/${encodeURIComponent(id)}`;

/** True when a change failed because the sign-in is older than 15 minutes. */
export const needsReauth = (e: unknown) => e instanceof RequestError && e.status === 403 && /sign in again/i.test(e.message);

export const adminSession = () => get<AdminSession>("/session");
export const listUsers = (q: string, page: number) =>
  get<{ users: AdminUserRow[]; total: number; page: number; pageSize: number }>(`/users?q=${encodeURIComponent(q)}&page=${page}`);
export const getUser = (id: string) => get<AdminUserDetail>(user(id));
export const getStats = () => get<AdminStats>("/stats");
export const getCatalog = () => get<AdminCatalog>("/catalog");
export const listAudit = (before?: string | null) => get<{ entries: AuditEntry[]; next: string | null }>(`/audit${before ? `?before=${encodeURIComponent(before)}` : ""}`);

export const banUser = (id: string, reason: string, days: number | null) => send("POST", `${user(id)}/ban`, { reason, ...(days ? { days } : {}) });
export const unbanUser = (id: string) => send("POST", `${user(id)}/unban`);
export const revokeSessions = (id: string) => send("POST", `${user(id)}/revoke-sessions`);
export const revokeUserKey = (id: string, keyId: string) => send("DELETE", `${user(id)}/keys/${encodeURIComponent(keyId)}`);
export const setQuota = (id: string, dailyUnits: number, reason: string) => send("PUT", `${user(id)}/quota`, { dailyUnits, reason });
export const clearQuota = (id: string) => send("DELETE", `${user(id)}/quota`);
export const setRole = (id: string, role: "admin" | "user") => send<{ success: boolean; note?: string }>("POST", `${user(id)}/role`, { role });
export const removeUser = (id: string) => send("DELETE", user(id), { confirm: id });
