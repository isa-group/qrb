"use client";

import { useCallback, useMemo, useState } from "react";

import { BindingResultPanel } from "@/components/binding-result-panel";
import { CatalogCacheStatus } from "@/components/catalog-cache-status";
import { ResourceCard } from "@/components/resource-card";
import { TaskSpecificationPanel } from "@/components/task-specification-panel";
import { useCatalog } from "@/hooks/use-catalog";
import { evaluateCandidate, type TaskSpec } from "@/lib/playground/eligibility";
import { resolveBinding, type ResolveOutcome } from "@/lib/playground/api";
import { deriveCircuitWidth } from "@/lib/playground/schema";
import type { TaskSpecFormValues } from "@/lib/playground/schema";

export default function PlaygroundPage() {
  const { data: catalog, queueHistory, timings, fetchLive, isFetchingLive } = useCatalog();
  const [task, setTask] = useState<TaskSpecFormValues | null>(null);
  const [outcome, setOutcome] = useState<ResolveOutcome | null>(null);
  const [resolving, setResolving] = useState(false);
  const [attempted, setAttempted] = useState(false);

  const handleChange = useCallback((values: TaskSpecFormValues | null) => {
    setTask(values);
  }, []);

  const handleResolve = useCallback(async (values: TaskSpecFormValues) => {
    setAttempted(true);
    setResolving(true);
    try {
      const result = await resolveBinding(values);
      setOutcome(result);
    } finally {
      setResolving(false);
    }
  }, []);

  // Live tier: instant, client-side (Question 4/8) — feasibility from a
  // quick qubit-count scan of the QASM text, not the real transpiled result.
  const taskSpec: TaskSpec | null = useMemo(() => {
    if (!task) return null;
    return {
      circuitWidth: deriveCircuitWidth(task.circuitQasm),
      providerConstraint: task.providerConstraint,
      constraints: task.constraints,
    };
  }, [task]);

  // §14/P2: filtered by structural feasibility only (width + provider),
  // never reordered — resolving a binding never touches this grid either.
  // Deliberately NOT the full `eligible` check: that also folds in whatever
  // constraints happen to be declared (e.g. a loaded preset's
  // operational >= 1), which would make offline resources disappear from
  // the catalog entirely instead of just showing as offline. This grid is
  // "what could run this circuit," not "what would satisfy my current
  // preferences" — the latter is what Resolve Binding is for.
  const referenceCatalog = useMemo(() => {
    if (!catalog) return [];
    if (!taskSpec) return catalog;
    return catalog.filter((r) => {
      const evaluation = evaluateCandidate(r, taskSpec);
      return evaluation.feasible && evaluation.meetsProvider;
    });
  }, [catalog, taskSpec]);

  // Validation errors (malformed circuit/preferences) surface near the
  // editor that produced them, not as a generic result banner (Question 7).
  const circuitError =
    outcome?.kind === "validation-error" ? outcome.message : undefined;

  return (
    <main className="mx-auto w-full max-w-(--page-max-width) flex-1 px-6 py-8">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="flex flex-col gap-6">
          <TaskSpecificationPanel
            onChange={handleChange}
            onResolve={handleResolve}
            resolving={resolving}
            circuitError={circuitError}
          />
        </div>

        <div>
          <BindingResultPanel
            outcome={outcome}
            attempted={attempted}
            resolving={resolving}
            catalog={catalog ?? []}
          />
        </div>
      </div>

      <div className="mt-10">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-subheading font-medium text-ink-primary">
              Reference catalog
            </h2>
            <p className="mt-1 text-caption text-ink-tertiary">
              Filtered by feasibility for the current task — never reordered by
              the binding result.
            </p>
          </div>
          <CatalogCacheStatus timings={timings} onFetchLive={fetchLive} fetching={isFetchingLive} />
        </div>
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {referenceCatalog.map((resource) => (
            <ResourceCard
              key={resource.candidate_id}
              resource={resource}
              queueHistory={queueHistory[resource.candidate_id] ?? []}
            />
          ))}
        </div>
      </div>
    </main>
  );
}
