"use client";

import { useEffect, useState } from "react";

import { formatDuration } from "@/lib/api/errors";
import type { QuotaInfo } from "@/lib/api/quota";

export function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function describeQuota(quota: QuotaInfo, now: number): string {
  const left = quota.limit !== null ? `${quota.remaining} of ${quota.limit}` : `${quota.remaining}`;
  const seconds = (quota.resetAtMs - now) / 1000;
  const reset = seconds > 0 ? `resets in ${formatDuration(seconds)}` : "resets at 00:00 UTC";
  return `${left} resolves left today · ${reset}`;
}

export function QuotaStatus({ quota }: { quota: QuotaInfo | null }) {
  const now = useNow();
  if (!quota) return null;
  return (
    <p className="mt-2 text-caption text-ink-tertiary" data-testid="quota-status">
      {describeQuota(quota, now)}
    </p>
  );
}
