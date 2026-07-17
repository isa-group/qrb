"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";

import { fetchCatalogResourceDetail, fetchCatalogResources } from "@/lib/api/catalog";
import { CATALOG_POLL_INTERVAL_MS } from "@/lib/query-config";

const HISTORY_LENGTH = 20;

export type QueueHistory = Record<string, number[]>;

/**
 * Polls /catalog on an interval and, client-side, accumulates a short rolling
 * history of queue_length per resource as new polls arrive. There's no
 * historical-queue endpoint on the backend (queue depth is only ever a live
 * snapshot), so the Telemetry Strip sparkline is real drift observed during
 * the session, not fabricated or backfilled.
 */
export function useCatalog(providers?: string[], options?: { enabled?: boolean }) {
  const queryClient = useQueryClient();
  const queryKey = ["catalog", providers ?? []];
  const query = useQuery({
    queryKey,
    queryFn: () => fetchCatalogResources(providers),
    refetchInterval: CATALOG_POLL_INTERVAL_MS,
    enabled: options?.enabled ?? true,
  });
  const resources = query.data?.resources;

  // Bypasses the 90s server-side cache for exactly this one request, then
  // writes the result straight into the query cache — the next scheduled
  // poll (and anything else reading this same queryKey) sees the fresh
  // data too, same as a normal cache miss would naturally propagate.
  const [isFetchingLive, setIsFetchingLive] = useState(false);
  const fetchLive = useCallback(async () => {
    setIsFetchingLive(true);
    try {
      const result = await fetchCatalogResources(providers, { forceRefresh: true });
      queryClient.setQueryData(queryKey, result);
    } finally {
      setIsFetchingLive(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers, queryClient]);

  // State, not a ref: a ref's `.current` mutates without triggering a
  // re-render, so reading it during render (as the old version did) served
  // the previous poll's history until some unrelated re-render happened to
  // catch it up.
  const [queueHistory, setQueueHistory] = useState<QueueHistory>({});

  useEffect(() => {
    if (!resources) return;
    // Accumulating history across query updates is exactly React's
    // documented "caching information from previous renders" case — there's
    // no pure-render way to remember earlier query.data values than this.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setQueueHistory((prev) => {
      const next = { ...prev };
      for (const resource of resources) {
        const history = next[resource.candidate_id] ?? [];
        next[resource.candidate_id] = [
          ...history,
          resource.queue_length,
        ].slice(-HISTORY_LENGTH);
      }
      return next;
    });
  }, [resources]);

  return {
    ...query,
    data: resources,
    timings: query.data?.timings,
    fetchLive,
    isFetchingLive,
    queueHistory,
  };
}

// Calibration detail (T1/T2, gate/readout error, native gate set) changes on
// the timescale of hardware recalibration, not seconds — a single fetch per
// candidate is enough, unlike the queue-length poll above.
export function useCatalogResourceDetail(candidateId: string | null) {
  return useQuery({
    queryKey: ["catalog-resource-detail", candidateId],
    queryFn: () => fetchCatalogResourceDetail(candidateId as string),
    enabled: candidateId !== null,
  });
}
