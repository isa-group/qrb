// Quota information from the gateway: X-Quota-* headers on counted responses
// and GET /usage. Neither is in schema.d.ts, so types are local.
import { API_BASE_URL } from "./client";

export interface QuotaInfo {
  limit: number | null;
  remaining: number;
  /** Absolute reset time, ms since epoch (next 00:00 UTC). */
  resetAtMs: number;
}

export interface UsageInfo {
  tier: "anonymous" | "signed_in";
  quota: number;
  used: number;
  remaining: number;
  resetAt: string;
  secondsUntilReset: number;
  ip?: { quota: number; used: number; remaining: number };
}

// null when the headers are absent (429s, open routes) or malformed.
export function parseQuotaHeaders(headers: Headers): QuotaInfo | null {
  const remaining = headers.get("X-Quota-Remaining");
  const reset = headers.get("X-Quota-Reset");
  if (remaining === null || reset === null) return null;
  const rem = Number(remaining);
  const resetSec = Number(reset);
  if (!Number.isFinite(rem) || !Number.isFinite(resetSec)) return null;
  const limitRaw = headers.get("X-Quota-Limit");
  const limit = limitRaw !== null && Number.isFinite(Number(limitRaw)) ? Number(limitRaw) : null;
  return { limit, remaining: rem, resetAtMs: resetSec * 1000 };
}

export function quotaFromUsage(usage: UsageInfo): QuotaInfo {
  return {
    limit: usage.quota,
    remaining: usage.remaining,
    resetAtMs: Date.parse(usage.resetAt),
  };
}

// null when the caller has no identity (401) — a brand-new visitor.
export async function fetchUsage(): Promise<UsageInfo | null> {
  const res = await fetch(`${API_BASE_URL}/usage`, { credentials: "include" });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error("Could not load usage");
  return (await res.json()) as UsageInfo;
}
