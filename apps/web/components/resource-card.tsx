import Link from "next/link";

import { MetricChip } from "@/components/metric-chip";
import { ProviderBadge } from "@/components/provider-badge";
import { Sparkline } from "@/components/sparkline";
import { StatusDot } from "@/components/status-dot";
import type { CatalogResource } from "@/lib/api/types";

// §10, §28: every card is visually identical in structure regardless of its
// numbers — no hover-lift, no shadow, just a border that brightens on hover.
export function ResourceCard({
  resource,
  queueHistory,
}: {
  resource: CatalogResource;
  queueHistory: number[];
}) {
  return (
    <Link
      href={`/catalog/resource?id=${encodeURIComponent(resource.candidate_id)}`}
      className="block rounded-md border border-hairline bg-instrument p-4 transition-colors hover:border-hairline-bright"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-body-lg font-medium text-ink-primary">
            {resource.name}
          </span>
          <ProviderBadge
            providerId={resource.provider_id}
            vendor={resource.provider_id === "braket" ? resource.vendor : undefined}
          />
        </div>
        <StatusDot live={resource.operational} />
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2">
        <MetricChip label="qubits" value={String(resource.num_qubits)} />
        <MetricChip label="queue" value={String(resource.queue_length)} />
      </div>

      <div className="mt-4 border-t border-hairline pt-3">
        {queueHistory.length > 1 ? (
          <Sparkline values={queueHistory} width={220} height={36} />
        ) : (
          <p className="text-mono-caption text-ink-faint">
            gathering telemetry…
          </p>
        )}
      </div>
    </Link>
  );
}
