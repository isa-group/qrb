"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import type { CatalogTimings } from "@/lib/api/types";

function formatAgo(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

// Surfaces the 90s server-side catalog cache (packages/qrb/src/qrb/
// providers/_live_cache.py's CatalogCache) instead of leaving it invisible:
// whether the data on screen came from that cache or a live fetch, when it
// was actually pulled, and a button to force a live fetch on demand.
export function CatalogCacheStatus({
  timings,
  onFetchLive,
  fetching,
}: {
  timings: CatalogTimings | undefined;
  onFetchLive: () => void;
  fetching: boolean;
}) {
  // Re-render every few seconds purely to keep "Xs ago" advancing without
  // waiting for the next poll — formatAgo itself just reads Date.now().
  const [, forceTick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => forceTick((t) => t + 1), 5000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex items-center gap-3 text-mono-caption text-ink-tertiary">
      {timings && (
        <span>
          {timings.catalog_cache_hit === false ? "● live fetch" : "● cached"}
          {timings.catalog_fetched_at && ` · populated ${formatAgo(timings.catalog_fetched_at)}`}
        </span>
      )}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onFetchLive}
        disabled={fetching}
      >
        {fetching ? "Fetching…" : "Fetch live"}
      </Button>
    </div>
  );
}
