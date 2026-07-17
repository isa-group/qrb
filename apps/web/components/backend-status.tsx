"use client";

import { useEngines } from "@/lib/playground/engines";
import { useBackendHealth } from "@/lib/playground/health";
import { cn } from "@/lib/utils";

// A live marker for whether the API (and, once reachable, its solver
// engines) are actually up — distinct from the Reference catalog's "live"
// badges, which are per-resource, not per-backend.
export function BackendStatus() {
  const health = useBackendHealth();
  const engines = useEngines();

  const online = health.data === true;
  const activeEngines = (engines.data ?? []).filter((e) => e.active).length;
  const totalEngines = engines.data?.length ?? 0;

  return (
    <div className="flex items-center gap-1.5 text-caption text-ink-tertiary">
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          online ? "bg-eligible" : "bg-violation"
        )}
      />
      {online ? (
        <span>
          Backend online
          {totalEngines > 0 ? ` · ${activeEngines}/${totalEngines} engines active` : ""}
        </span>
      ) : (
        <span>Backend unreachable</span>
      )}
    </div>
  );
}
