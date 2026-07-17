"use client";

import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";

import { ProviderBadge } from "@/components/provider-badge";
import type { CatalogResource } from "@/lib/api/types";
import type { components } from "@/lib/api/schema";
import { cn } from "@/lib/utils";

type Solution = components["schemas"]["Solution"];

function formatFeatureValue(key: string, value: number): string {
  if (key === "cost") return `$${value.toFixed(4)}`;
  if (key.includes("fidelity") || key.includes("probability"))
    return value.toFixed(3);
  if (key === "queue") return `${value} pending`;
  return value.toFixed(3);
}

// Multi (Pareto) mode returns several non-dominated solutions — none of
// them is "the" answer, so this replaces the single winner card with a
// sortable table instead of picking one to highlight.
export function SolutionsComparisonTable({
  solutions,
  catalog,
}: {
  solutions: Solution[];
  catalog: CatalogResource[];
}) {
  const featureKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const solution of solutions) {
      for (const key of Object.keys(solution.aggregated_features ?? {})) {
        if (!key.endsWith("_normalized")) keys.add(key);
      }
    }
    return Array.from(keys);
  }, [solutions]);

  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortAsc, setSortAsc] = useState(true);

  const rows = useMemo(() => {
    return solutions.map((solution) => {
      const candidateId = Object.values(solution.binding)[0];
      const resource = catalog.find((r) => r.candidate_id === candidateId);
      return { solution, candidateId, resource };
    });
  }, [solutions, catalog]);

  const sortedRows = useMemo(() => {
    if (!sortKey) return rows;
    const withValues = rows.map((row) => ({
      ...row,
      sortValue: row.solution.aggregated_features?.[sortKey] ?? 0,
    }));
    withValues.sort((a, b) =>
      sortAsc ? a.sortValue - b.sortValue : b.sortValue - a.sortValue
    );
    return withValues;
  }, [rows, sortKey, sortAsc]);

  function toggleSort(key: string) {
    if (sortKey === key) {
      setSortAsc((prev) => !prev);
    } else {
      setSortKey(key);
      setSortAsc(true);
    }
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-hairline">
      <table className="w-full min-w-max border-collapse text-body">
        <thead>
          <tr className="border-b border-hairline bg-instrument">
            <th className="px-3 py-2 text-left text-caption font-medium text-ink-secondary">
              Resource
            </th>
            {featureKeys.map((key) => (
              <th key={key} className="px-3 py-2 text-right">
                <button
                  type="button"
                  onClick={() => toggleSort(key)}
                  className="inline-flex items-center gap-1 text-caption font-medium text-ink-secondary hover:text-ink-primary"
                >
                  {key}
                  {sortKey === key ? (
                    sortAsc ? (
                      <ArrowUp className="size-3" />
                    ) : (
                      <ArrowDown className="size-3" />
                    )
                  ) : (
                    <ArrowUpDown className="size-3 text-ink-tertiary" />
                  )}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sortedRows.map(({ solution, candidateId, resource }, index) => (
            <tr
              key={candidateId ?? index}
              className={cn(
                "border-b border-hairline last:border-0",
                index % 2 === 1 && "bg-instrument/50"
              )}
            >
              <td className="px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="text-ink-primary">
                    {resource?.name ?? candidateId ?? "Unknown resource"}
                  </span>
                  {resource && (
                    <ProviderBadge
                      providerId={resource.provider_id}
                      vendor={resource.provider_id === "braket" ? resource.vendor : undefined}
                    />
                  )}
                </div>
              </td>
              {featureKeys.map((key) => {
                const value = solution.aggregated_features?.[key];
                return (
                  <td
                    key={key}
                    className="px-3 py-2 text-right font-geist-mono text-mono-body text-ink-primary"
                  >
                    {value === undefined ? "—" : formatFeatureValue(key, value)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
