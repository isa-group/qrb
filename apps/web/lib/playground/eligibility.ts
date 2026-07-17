import type { CatalogResource } from "@/lib/api/types";

import type { ConstraintOp } from "./constraint-ops";
import type { ConstraintsFormValue } from "./schema";

// Live, instant, client-side — deliberately limited to checks that are
// exact given only catalog data (no fake fidelity/cost estimates; those
// require real transpilation + calibration data server-side, see
// lib/playground/api.ts for the real resolve call). num_qubits >= width is
// the actual, complete feasibility constraint (CONTEXT.md §Feasibility
// Constraint), not an approximation of something richer — so it's exact to
// check here, unlike fidelity/cost.
export interface TaskSpec {
  circuitWidth: number | null;
  providerConstraint?: "any" | "ibm" | "braket";
  constraints: ConstraintsFormValue;
}

// Features whose value is exactly derivable from CatalogResource alone —
// everything else (expected_fidelity, cost, critical_depth,
// estimated_success_probability, depth_feasible) needs a real transpile
// and only shows up as "checked when you resolve" in the Inspector.
const LIVE_CHECKABLE_FEATURES = new Set([
  "num_qubits",
  "queue",
  "operational",
  "calibration_age_hours",
]);

export function isLiveCheckable(feature: string): boolean {
  return LIVE_CHECKABLE_FEATURES.has(feature);
}

// Mirrors qrb.features.UNKNOWN_CALIBRATION_AGE_HOURS's sentinel intent:
// a resource with no calibration timestamp fails a max-age constraint
// rather than silently passing.
function calibrationAgeHours(resource: CatalogResource): number {
  if (!resource.last_calibrated_at) return Infinity;
  const ageMs = Date.now() - new Date(resource.last_calibrated_at).getTime();
  return ageMs / (1000 * 60 * 60);
}

function liveValueFor(feature: string, resource: CatalogResource): number | null {
  switch (feature) {
    case "num_qubits":
      return resource.num_qubits;
    case "queue":
      return resource.queue_length;
    case "operational":
      return resource.operational ? 1 : 0;
    case "calibration_age_hours":
      return calibrationAgeHours(resource);
    default:
      return null;
  }
}

function compare(actual: number, op: ConstraintOp, expected: number): boolean {
  switch (op) {
    case "<=":
      return actual <= expected;
    case ">=":
      return actual >= expected;
    case "==":
      return actual === expected;
    case "<":
      return actual < expected;
    case ">":
      return actual > expected;
  }
}

// null when the feature isn't live-checkable (server-solve-only) — distinct
// from a real true/false result.
export function checkLiveConstraint(
  resource: CatalogResource,
  feature: string,
  op: ConstraintOp,
  value: number
): boolean | null {
  if (!isLiveCheckable(feature)) return null;
  const actual = liveValueFor(feature, resource);
  if (actual === null) return null;
  return compare(actual, op, value);
}

export interface CandidateEvaluation {
  resource: CatalogResource;
  feasible: boolean;
  meetsProvider: boolean;
  meetsLiveConstraints: boolean;
  eligible: boolean;
}

export function evaluateCandidate(
  resource: CatalogResource,
  task: TaskSpec
): CandidateEvaluation {
  const feasible =
    task.circuitWidth === null || resource.num_qubits >= task.circuitWidth;
  const meetsProvider =
    !task.providerConstraint ||
    task.providerConstraint === "any" ||
    resource.provider_id === task.providerConstraint;

  const meetsLiveConstraints = Object.entries(task.constraints).every(
    ([feature, { op, value }]) =>
      checkLiveConstraint(resource, feature, op, value) ?? true
  );

  return {
    resource,
    feasible,
    meetsProvider,
    meetsLiveConstraints,
    eligible: feasible && meetsProvider && meetsLiveConstraints,
  };
}
