import { apiClient } from "./client";
import { jitterCatalog, MOCK_CALIBRATION_DETAILS, MOCK_CATALOG } from "./mock-catalog";
import type { CatalogResource, CatalogResourceDetail, CatalogTimings } from "./types";

// Toggle in .env — real provider credentials (IBM Quantum / Amazon Braket)
// usually aren't available in dev/demo environments, so mock data is the
// default. Set to "false" once apps/api has live credentials configured.
export const USE_MOCK_CATALOG =
  process.env.NEXT_PUBLIC_USE_MOCK_CATALOG !== "false";

export interface CatalogFetchResult {
  resources: CatalogResource[];
  timings: CatalogTimings;
}

// Mock mode has no real cache to report on — a fixed, always-"cached"
// answer is honest (there's no live/cache distinction to speak of) and
// avoids a fetched_at timestamp that silently drifts every render.
const MOCK_TIMINGS: CatalogTimings = {
  catalog_ms: 0,
  catalog_cache_hit: true,
  catalog_fetched_at: new Date(0).toISOString(),
  request_total_ms: 0,
};

export async function fetchCatalogResources(
  providers?: string[],
  options?: { forceRefresh?: boolean }
): Promise<CatalogFetchResult> {
  if (USE_MOCK_CATALOG) {
    const filtered = providers?.length
      ? MOCK_CATALOG.filter((r) => providers.includes(r.provider_id))
      : MOCK_CATALOG;
    return { resources: jitterCatalog(filtered), timings: MOCK_TIMINGS };
  }

  const { data, error } = await apiClient.GET("/catalog", {
    params: {
      query: { provider: providers, live: true, force_refresh: options?.forceRefresh },
    },
  });
  if (error) throw new Error("Failed to load catalog");
  return { resources: data.result as unknown as CatalogResource[], timings: data.timings_ms };
}

export async function fetchCatalogResourceDetail(
  candidateId: string
): Promise<CatalogResourceDetail | null> {
  if (USE_MOCK_CATALOG) {
    const base = MOCK_CATALOG.find((r) => r.candidate_id === candidateId);
    if (!base) return null;
    const calibration = MOCK_CALIBRATION_DETAILS[candidateId];
    return {
      ...base,
      native_gates: calibration?.native_gates ?? [],
      median_t1_us: calibration?.median_t1_us ?? null,
      median_t2_us: calibration?.median_t2_us ?? null,
      median_gate_error_1q: calibration?.median_gate_error_1q ?? null,
      median_gate_error_2q: calibration?.median_gate_error_2q ?? null,
      median_readout_error: calibration?.median_readout_error ?? null,
    };
  }

  const { data, error } = await apiClient.GET("/catalog/{candidate_id}", {
    params: { path: { candidate_id: candidateId }, query: { live: true } },
  });
  if (error) return null;
  return data.result as unknown as CatalogResourceDetail;
}
