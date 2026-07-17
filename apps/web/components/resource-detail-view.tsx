"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";

import { MetricChip } from "@/components/metric-chip";
import { ProviderBadge } from "@/components/provider-badge";
import { Sparkline } from "@/components/sparkline";
import { StatusDot } from "@/components/status-dot";
import { useCatalog, useCatalogResourceDetail } from "@/hooks/use-catalog";

function formatDuration(us: number): string {
  if (us >= 1_000_000) return `${(us / 1_000_000).toFixed(2)} s`;
  if (us >= 1_000) return `${(us / 1_000).toFixed(1)} ms`;
  return `${us.toFixed(1)} µs`;
}

function formatAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

export function ResourceDetailView() {
  const searchParams = useSearchParams();
  const id = searchParams.get("id");

  const { data, queueHistory, isLoading } = useCatalog();
  const resource = data?.find((r) => r.candidate_id === id);
  const { data: detail } = useCatalogResourceDetail(id);

  if (isLoading) {
    return <main className="flex-1 px-6 py-8" />;
  }

  if (!resource) {
    return (
      <main className="mx-auto w-full max-w-(--page-max-width) flex-1 px-6 py-8">
        <p className="text-body text-ink-secondary">
          Resource not found.{" "}
          <Link href="/catalog" className="text-primary underline">
            Back to Catalog
          </Link>
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-(--page-max-width) flex-1 px-6 py-8">
      <nav className="flex items-center gap-1.5 text-body text-ink-tertiary">
        <Link href="/catalog" className="hover:text-ink-primary">
          Catalog
        </Link>
        <span>/</span>
        <span className="text-ink-primary">{resource.name}</span>
      </nav>

      <div className="mt-4 flex items-center gap-3">
        <h1 className="font-geist-sans text-heading font-medium text-ink-primary">
          {resource.name}
        </h1>
        <ProviderBadge
          providerId={resource.provider_id}
          vendor={resource.provider_id === "braket" ? resource.vendor : undefined}
        />
        <StatusDot live={resource.operational} />
      </div>

      <div className="mt-8 grid grid-cols-1 gap-8 lg:grid-cols-2">
        <section>
          <h2 className="text-subheading font-medium text-ink-primary">
            Metrics
          </h2>
          <div className="mt-3 grid grid-cols-3 gap-2">
            <MetricChip label="qubits" value={String(resource.num_qubits)} />
            <MetricChip label="queue" value={String(resource.queue_length)} />
            <MetricChip
              label="last calibrated"
              value={
                resource.last_calibrated_at
                  ? formatAgo(resource.last_calibrated_at)
                  : "—"
              }
            />
            <MetricChip
              label="median T1"
              value={
                detail?.median_t1_us != null
                  ? formatDuration(detail.median_t1_us)
                  : "—"
              }
            />
            <MetricChip
              label="median T2"
              value={
                detail?.median_t2_us != null
                  ? formatDuration(detail.median_t2_us)
                  : "—"
              }
            />
            <MetricChip
              label="1q gate error"
              value={
                detail?.median_gate_error_1q != null
                  ? detail.median_gate_error_1q.toFixed(4)
                  : "—"
              }
            />
            <MetricChip
              label="2q gate error"
              value={
                detail?.median_gate_error_2q != null
                  ? detail.median_gate_error_2q.toFixed(4)
                  : "—"
              }
            />
            <MetricChip
              label="readout error"
              value={
                detail?.median_readout_error != null
                  ? detail.median_readout_error.toFixed(4)
                  : "—"
              }
            />
          </div>
        </section>

        <section>
          <h2 className="text-subheading font-medium text-ink-primary">
            Native gate set
          </h2>
          <div className="mt-3 flex flex-wrap gap-2">
            {detail?.native_gates?.length ? (
              detail.native_gates.map((gate) => (
                <span
                  key={gate}
                  className="rounded-xs bg-deep-well px-2 py-1 font-geist-mono text-mono-body text-ink-primary"
                >
                  {gate}
                </span>
              ))
            ) : (
              <p className="text-body text-ink-tertiary">
                No gate-set data for this resource.
              </p>
            )}
          </div>
        </section>

        <section className="lg:col-span-2">
          <h2 className="text-subheading font-medium text-ink-primary">
            Recent drift — queue depth
          </h2>
          <div className="mt-3 rounded-md border border-hairline bg-instrument p-4">
            {queueHistory[resource.candidate_id]?.length > 1 ? (
              <Sparkline
                values={queueHistory[resource.candidate_id]}
                width={420}
                height={56}
              />
            ) : (
              <p className="text-mono-caption text-ink-faint">
                gathering telemetry…
              </p>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
