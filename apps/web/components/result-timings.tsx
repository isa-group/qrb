"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { TimingsResponse } from "@/lib/playground/api";
import { cn } from "@/lib/utils";

function formatMs(ms: number): string {
  return `${ms.toFixed(1)}ms`;
}

function TimingRow({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <li className="flex items-center justify-between text-body">
      <span className={emphasis ? "font-medium text-ink-primary" : "text-ink-secondary"}>
        {label}
      </span>
      <span className="font-geist-mono text-mono-body text-ink-primary">{value}</span>
    </li>
  );
}

// Every /select and /instance response carries a real phase-level timing
// breakdown (catalog fetch, per-resource transpile/feature calc, instance
// assembly, plus the full request wall time) — this is that data finally
// surfaced in the UI instead of being fetched and silently dropped.
export function ResultTimings({ timings }: { timings: TimingsResponse }) {
  const [perResourceOpen, setPerResourceOpen] = useState(false);
  const inst = timings.instance;
  const infeasibleEntries = Object.entries(inst.infeasible_reasons ?? {});
  const infeasibleSet = new Set(infeasibleEntries.map(([id]) => id));

  // Slowest transpile first — the whole point of a per-resource view is
  // spotting outliers, not reading them in whatever order the fan-out
  // happened to resolve in.
  const perResource = Object.entries(inst.per_resource ?? {}).sort(
    ([, a], [, b]) => b.transpile_ms - a.transpile_ms
  );

  const cacheNote =
    timings.catalog_cache_hit === null
      ? undefined
      : timings.catalog_cache_hit
        ? "cache hit"
        : "live fetch";

  return (
    <div className="rounded-md border border-hairline bg-panel p-4">
      <h4 className="font-geist-mono text-mono-caption font-medium text-ink-tertiary">
        TIMINGS
      </h4>
      <ul className="mt-2 flex flex-col gap-1">
        <TimingRow
          label="catalog"
          value={cacheNote ? `${formatMs(timings.catalog_ms)} · ${cacheNote}` : formatMs(timings.catalog_ms)}
        />
        <TimingRow
          label="transpile"
          value={`${formatMs(inst.transpile_ms)} · ${perResource.length} resources, summed`}
        />
        <TimingRow label="features" value={`${formatMs(inst.features_ms)} · summed`} />
        <TimingRow label="build instance" value={formatMs(inst.build_instance_ms)} />
        <TimingRow label="total (build)" value={formatMs(timings.total_ms)} emphasis />
        <TimingRow label="total (request)" value={formatMs(timings.request_total_ms)} emphasis />
      </ul>

      {perResource.length > 0 && (
        <Collapsible open={perResourceOpen} onOpenChange={setPerResourceOpen} className="mt-3 border-t border-hairline pt-2">
          <CollapsibleTrigger className="flex w-full items-center justify-between text-body text-ink-secondary hover:text-ink-primary">
            <span>Per-resource breakdown ({perResource.length})</span>
            <ChevronDown
              className={cn("size-4 transition-transform", perResourceOpen && "rotate-180")}
            />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul className="mt-2 flex flex-col gap-1">
              {perResource.map(([candidateId, phases]) => (
                <li
                  key={candidateId}
                  className="flex items-center justify-between text-mono-caption"
                >
                  <span className={infeasibleSet.has(candidateId) ? "text-violation" : "text-ink-secondary"}>
                    {candidateId}
                    {infeasibleSet.has(candidateId) && ` (${(inst.infeasible_reasons ?? {})[candidateId]})`}
                  </span>
                  <span className="font-geist-mono text-ink-primary">
                    transpile {phases.transpile_ms.toFixed(1)}ms · features{" "}
                    {phases.features_ms.toFixed(1)}ms
                  </span>
                </li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}
