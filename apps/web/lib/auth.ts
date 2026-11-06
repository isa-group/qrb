"use client";

import { useEffect, useSyncExternalStore } from "react";

import { API_BASE_URL } from "./api/client";

/**
 * Accounts live on the gateway (apps/gateway): sign-in with GitHub or ORCID (Better Auth, under
 * `<API>/auth/*`), one API key per account (`<API>/keys`) and the caller's daily budget
 * (`<API>/usage`). Every call sends the session cookie. Talking to the Python API directly (local
 * development without the gateway), none of this exists and the account UI hides itself.
 */

export type Provider = "github" | "orcid";

export interface AccountUser {
  id: string;
  name: string;
  /** Null when the provider gave no verified address (ORCID usually). */
  email: string | null;
  image: string | null;
}

export type AccountState =
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "signed-out" }
  | { status: "signed-in"; user: AccountUser };

export interface Usage {
  tier: "anonymous" | "signed_in";
  quota: number;
  used: number;
  remaining: number;
  resetAt: string;
  secondsUntilReset: number;
  costs: { resolve: number; liveRefresh: number };
  burst: { windowSeconds: number; limit: number; apiKeyLimit?: number };
  /** Keyless callers only: the daily units an account gets. */
  signedInQuota?: number;
}

export type Source = "key" | "browser";

export interface DailyUsage {
  /** UTC day, `YYYY-MM-DD`; 30 entries, oldest first, today last. */
  day: string;
  /** Units by source; an async bind still resolving counts here already, on its own source. */
  key: number;
  browser: number;
  /** Units held by async binds still resolving (part of `key` and `browser`; refunded if they fail). */
  pending?: number;
}

export interface LoggedRequest {
  id: string;
  at: string;
  source: Source;
  apiKeyStart: string | null;
  method: string;
  path: string;
  cost: number;
  status: number;
  durationMs: number;
}

export interface BindWinner {
  id: string;
  name: string;
  provider: string | null;
}

export interface BindSummary {
  feasibility: string | null;
  solutions: number;
  candidates: number;
  winners: BindWinner[];
  engine: string | null;
  source: { mode: string | null; as_of: string | null; cache_hit: boolean | null };
}

export interface StoredBind {
  id: string;
  /** `pending` and `failed` only for async binds (`POST /api/binds`); a synchronous bind is `done`. */
  status: "pending" | "done" | "failed";
  error: string | null;
  at: string;
  source: Source;
  apiKeyStart: string | null;
  cost: number;
  preferences: {
    preset?: string;
    weights?: Record<string, number>;
    constraints?: { feature: string; op: string; value: number }[];
    require_provider?: string | null;
    pareto?: boolean;
  };
  shots: number;
  live: boolean;
  /** Null until the bind is done. */
  summary: BindSummary | null;
}

export interface StoredBindDetail extends StoredBind {
  request: { circuit_qasm: string; preferences: StoredBind["preferences"]; shots: number; live: boolean; force_refresh: boolean };
}

export interface Page<T> {
  items: T[];
  next: string | null;
}

export interface ApiKey {
  id: string;
  name: string | null;
  /** First characters of the key, to recognise it. */
  start: string | null;
  prefix: string | null;
  createdAt: string;
}

export class RequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Gateway placeholders for accounts without a verified email (see apps/gateway email-policy). */
const PLACEHOLDER_DOMAIN = "@users.noreply.invalid";

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      credentials: "include",
      headers: init.body ? { "content-type": "application/json", ...init.headers } : init.headers,
    });
  } catch {
    throw new RequestError("The QRB server could not be reached. Check your connection and try again.", 0);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = (body as { detail?: unknown; message?: unknown } | null)?.detail ?? (body as { message?: unknown } | null)?.message;
    throw new RequestError(typeof detail === "string" ? detail : `The server answered ${res.status}.`, res.status);
  }
  return body as T;
}

// ---------- session store (shared by the nav and the account pages) ----------

const LOADING: AccountState = { status: "loading" };
let state: AccountState = LOADING;
let pending: Promise<void> | null = null;
const listeners = new Set<() => void>();

function set(next: AccountState) {
  state = next;
  for (const l of listeners) l();
}

/** Reads the session once per page load (or again after `refreshAccount`). */
function load(): Promise<void> {
  pending ??= (async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/auth/get-session`, { credentials: "include", cache: "no-store" });
      if (!res.ok) return set({ status: "unavailable" });
      const body = (await res.json().catch(() => undefined)) as { user?: Partial<AccountUser> & { id: string } } | null | undefined;
      if (body === undefined) return set({ status: "unavailable" });
      if (!body?.user) return set({ status: "signed-out" });
      const u = body.user;
      const email = typeof u.email === "string" && !u.email.toLowerCase().endsWith(PLACEHOLDER_DOMAIN) ? u.email : null;
      set({ status: "signed-in", user: { id: u.id, name: u.name || "Your account", email, image: u.image ?? null } });
    } catch {
      set({ status: "unavailable" });
    }
  })();
  return pending;
}

export function refreshAccount(): Promise<void> {
  pending = null;
  return load();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useAccount(): AccountState {
  const s = useSyncExternalStore(
    subscribe,
    () => state,
    () => LOADING,
  );
  useEffect(() => {
    void load();
  }, []);
  return s;
}

// ---------- actions ----------

/** Starts OAuth with the provider; the browser leaves the site and comes back to `/account`. */
export async function signIn(provider: Provider): Promise<void> {
  const origin = window.location.origin;
  const { url } = await call<{ url: string }>("/auth/sign-in/social", {
    method: "POST",
    body: JSON.stringify({ provider, callbackURL: `${origin}/account`, errorCallbackURL: `${origin}/signin`, disableRedirect: true }),
  });
  window.location.assign(url);
}

export async function signOut(): Promise<void> {
  await call("/auth/sign-out", { method: "POST", body: "{}" });
  await refreshAccount();
}

export const linkedProviders = () => call<{ providerId: string }[]>("/auth/list-accounts").then((rows) => rows.map((r) => r.providerId));

export const getUsage = () => call<Usage>("/usage", { cache: "no-store" });

export const listKeys = () => call<{ keys: ApiKey[] }>("/keys", { cache: "no-store" }).then((r) => r.keys);

export const createKey = () => call<ApiKey & { key: string }>("/keys", { method: "POST", body: "{}" });

export const getDaily = () => call<{ days: DailyUsage[] }>("/usage/daily", { cache: "no-store" }).then((r) => r.days);

const page = (before?: string | null) => (before ? `?before=${encodeURIComponent(before)}` : "");

export const listRequests = (before?: string | null): Promise<Page<LoggedRequest>> =>
  call<{ requests: LoggedRequest[]; next: string | null }>(`/history/requests${page(before)}`, { cache: "no-store" }).then((r) => ({ items: r.requests, next: r.next }));

export const listBinds = (before?: string | null): Promise<Page<StoredBind>> =>
  call<{ binds: StoredBind[]; next: string | null }>(`/history/binds${page(before)}`, { cache: "no-store" }).then((r) => ({ items: r.binds, next: r.next }));

export const getBind = (id: string) => call<StoredBindDetail>(`/history/binds/${encodeURIComponent(id)}`, { cache: "no-store" });

export const deleteBind = (id: string) => call<{ success: boolean }>(`/history/binds/${encodeURIComponent(id)}`, { method: "DELETE" });

export const clearBinds = () => call<{ deleted: number }>("/history/binds", { method: "DELETE" });

/** Full 30-day CSV export; a plain link, so the browser downloads it with the session cookie. */
export const csvUrl = (what: "binds" | "requests") => `${API_BASE_URL}/history/${what}?format=csv`;

export const revokeKey = (id: string) => call<{ success: boolean }>(`/keys/${encodeURIComponent(id)}`, { method: "DELETE" });
