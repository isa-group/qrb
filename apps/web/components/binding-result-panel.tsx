import Link from "next/link";

import { JsonDisclosure } from "@/components/json-disclosure";
import { ProviderBadge } from "@/components/provider-badge";
import { ResultTimings } from "@/components/result-timings";
import { SolutionsComparisonTable } from "@/components/solutions-comparison-table";
import type { CatalogResource } from "@/lib/api/types";
import type { ResolveOutcome } from "@/lib/playground/api";

function formatFeatureValue(key: string, value: number): string {
  if (key === "cost") return `$${value.toFixed(4)}`;
  if (key.includes("fidelity")) return value.toFixed(3);
  if (key === "queue") return `${value} pending`;
  return String(value);
}

// §10: the output of pressing Resolve Binding. Lives beside/below the
// catalog, never inside it — the one surface in the system permitted a
// colored (violet) border. No score, no percentage "match", no numeric rank.
export function BindingResultPanel({
  outcome,
  attempted,
  resolving,
  catalog,
}: {
  outcome: ResolveOutcome | null;
  attempted: boolean;
  resolving: boolean;
  catalog: CatalogResource[];
}) {
  if (!attempted) {
    return (
      <div className="rounded-lg border border-hairline bg-instrument p-4">
        <p className="text-body text-ink-tertiary">
          Fill in the task specification and press Resolve Binding.
        </p>
      </div>
    );
  }

  if (resolving) {
    return (
      <div className="rounded-lg border border-hairline bg-instrument p-4">
        <p className="text-body text-ink-tertiary">Resolving…</p>
      </div>
    );
  }

  // Validation errors render near the circuit editor instead (see
  // TaskSpecificationPanel's circuitError prop) — nothing result-shaped to
  // show here.
  if (!outcome || outcome.kind === "validation-error") {
    return (
      <div className="rounded-lg border border-hairline bg-instrument p-4">
        <p className="text-body text-ink-tertiary">
          Fix the circuit above and press Resolve Binding again.
        </p>
      </div>
    );
  }

  if (outcome.kind === "unavailable") {
    return (
      <div className="rounded-lg border border-violation bg-violation-dim p-4">
        <p className="text-body text-violation">{outcome.message}</p>
      </div>
    );
  }

  if (outcome.kind === "infeasible") {
    return (
      <div className="flex flex-col gap-4">
        <div className="rounded-lg border border-violation bg-violation-dim p-4">
          <p className="text-body text-violation">
            No candidate satisfies these constraints. Loosen a constraint and
            try again.
          </p>
        </div>
        <ResultTimings timings={outcome.timings} />
        <div className="rounded-md border border-hairline bg-panel p-4">
          {outcome.instance && (
            <JsonDisclosure label="Instance JSON" value={outcome.instance} />
          )}
          <JsonDisclosure label="Response JSON" value={outcome.response} />
        </div>
      </div>
    );
  }

  const solutions = outcome.response.solutions;

  // Multi (Pareto) mode returns several non-dominated solutions — none of
  // them is "the" answer, so a comparison table replaces the single winner
  // card rather than arbitrarily highlighting solutions[0].
  if (solutions.length > 1) {
    return (
      <div className="flex flex-col gap-4">
        <SolutionsComparisonTable solutions={solutions} catalog={catalog} />
        <ResultTimings timings={outcome.timings} />
        <div className="rounded-md border border-hairline bg-panel p-4">
          {outcome.instance && (
            <JsonDisclosure label="Instance JSON" value={outcome.instance} />
          )}
          <JsonDisclosure label="Response JSON" value={outcome.response} />
        </div>
      </div>
    );
  }

  const solution = solutions[0];
  const candidateId = solution
    ? Object.values(solution.binding)[0]
    : undefined;
  const resource = catalog.find((r) => r.candidate_id === candidateId);

  return (
    <div className="flex flex-col gap-4">
      <div
        className="rounded-lg border border-primary p-4"
        style={{ background: "var(--color-primary-dim)" }}
      >
        <div className="flex items-center gap-2">
          <h3 className="font-geist-sans text-heading-sm font-medium text-ink-primary">
            {resource?.name ?? candidateId ?? "Unknown resource"}
          </h3>
          {resource && (
            <ProviderBadge
              providerId={resource.provider_id}
              vendor={resource.provider_id === "braket" ? resource.vendor : undefined}
            />
          )}
        </div>

        {solution && (
          <ul className="mt-3 flex flex-col gap-1.5">
            {Object.entries(solution.aggregated_features ?? {})
              .filter(([key]) => !key.endsWith("_normalized"))
              .map(([key, value]) => (
                <li
                  key={key}
                  className="flex items-center justify-between text-body text-ink-primary"
                >
                  <span className="text-ink-secondary">{key}</span>
                  <span className="font-geist-mono text-mono-body">
                    {formatFeatureValue(key, value)}
                  </span>
                </li>
              ))}
          </ul>
        )}

        {resource && (
          <Link
            href={`/catalog/resource?id=${encodeURIComponent(resource.candidate_id)}`}
            className="mt-4 inline-block text-body font-medium text-primary hover:underline"
          >
            View resource →
          </Link>
        )}
      </div>

      <ResultTimings timings={outcome.timings} />

      <div className="rounded-md border border-hairline bg-panel p-4">
        {outcome.instance && (
          <JsonDisclosure label="Instance JSON" value={outcome.instance} />
        )}
        <JsonDisclosure label="Response JSON" value={outcome.response} />
      </div>
    </div>
  );
}
