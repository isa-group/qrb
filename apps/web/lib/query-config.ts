// How often live catalog/telemetry queries refetch in the background.
// Configurable per-environment since live provider fetches (IBM/Braket) hit
// real rate-limited APIs — see .env.example. Defaults to 10 minutes.
//
// This is distinct from the design doc's 60s "live" status-dot threshold
// (see components/resource-card.tsx), which is about how fresh a data point
// looks, not how often we ask the backend for a new one.
export const CATALOG_POLL_INTERVAL_MS = Number(
  process.env.NEXT_PUBLIC_CATALOG_POLL_INTERVAL_MS ?? 10 * 60 * 1000
);
