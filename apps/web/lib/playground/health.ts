"use client";

import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";

async function checkHealth(): Promise<boolean> {
  const result = await apiClient.GET("/health").catch(() => null);
  return !!result && !result.error;
}

// Short interval and no retries — this drives a live "is the backend up"
// marker, so a slow/failed check should flip the indicator quickly rather
// than hang onto stale "online" state.
export function useBackendHealth() {
  return useQuery({
    queryKey: ["health"],
    queryFn: checkHealth,
    refetchInterval: 15_000,
    retry: false,
  });
}
