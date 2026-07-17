// Mirrors qrb.features.FEATURE_REGISTRY — every feature a generic
// ConstraintSpec may target, including ones with no weight (num_qubits,
// operational, depth_feasible, calibration_age_hours are constraint-only
// on the backend too). Kept in sync by hand, like objective-features.ts.
export type FeatureDirection = "maximize" | "minimize";

export interface ConstrainableFeature {
  id: string;
  label: string;
  description: string;
  direction: FeatureDirection;
  unit: string;
  /** A starting value a typical user would recognize as meaningful for
   * this feature, so a freshly-added row isn't an arbitrary 0 the user has
   * to guess how to change (e.g. "cost <= 0" reads as nonsensical). Not a
   * recommendation to actually use this exact number — just a sane anchor
   * to edit from. */
  defaultValue: number;
}

export const CONSTRAINABLE_FEATURES: ConstrainableFeature[] = [
  {
    id: "expected_fidelity",
    label: "Expected fidelity",
    description: "Product of per-gate and readout fidelities, 0 to 1.",
    direction: "maximize",
    unit: "probability",
    defaultValue: 0.9,
  },
  {
    id: "cost",
    label: "Cost",
    description: "Estimated execution cost in USD.",
    direction: "minimize",
    unit: "USD",
    defaultValue: 10,
  },
  {
    id: "queue",
    label: "Queue length",
    description: "Pending jobs ahead of yours.",
    direction: "minimize",
    unit: "pending jobs",
    defaultValue: 50,
  },
  {
    id: "critical_depth",
    label: "Critical depth",
    description:
      "Share of 2-qubit gates on the compiled circuit's critical path, 0 (parallel) to 1 (sequential).",
    direction: "minimize",
    unit: "ratio",
    defaultValue: 0.5,
  },
  {
    id: "estimated_success_probability",
    label: "Estimated success probability",
    description:
      "Expected fidelity discounted by T1/T2 decoherence during idle time, 0 to 1.",
    direction: "maximize",
    unit: "probability",
    defaultValue: 0.9,
  },
  {
    id: "num_qubits",
    label: "Number of qubits",
    description:
      "Qubit capacity of the resource. Width feasibility (num_qubits ≥ circuit width) is already enforced automatically — use this to require extra headroom beyond that.",
    direction: "maximize",
    unit: "qubits",
    defaultValue: 50,
  },
  {
    id: "operational",
    label: "Operational",
    description: "1 if the provider reports the resource as operational, else 0.",
    direction: "maximize",
    unit: "boolean (0 or 1)",
    defaultValue: 1,
  },
  {
    id: "depth_feasible",
    label: "Depth feasible",
    description:
      "1 if the compiled circuit's depth is within the resource's T1-derived bound (NISQ Analyzer), else 0. Always enforced internally already — constraining it yourself is redundant but allowed.",
    direction: "maximize",
    unit: "boolean (0 or 1)",
    defaultValue: 1,
  },
  {
    id: "calibration_age_hours",
    label: "Calibration age",
    description: "Hours since the resource was last calibrated.",
    direction: "minimize",
    unit: "hours",
    defaultValue: 24,
  },
];

export const CONSTRAINABLE_FEATURE_BY_ID = new Map(
  CONSTRAINABLE_FEATURES.map((f) => [f.id, f])
);

export function labelForConstrainableFeature(id: string): string {
  return CONSTRAINABLE_FEATURE_BY_ID.get(id)?.label ?? id;
}

// Sensible default operator for a newly-added constraint row, matching the
// old dedicated fields' convention (max_cost implied <=, min_fidelity
// implied >=): bound a MAXIMIZE feature from below (>=), a MINIMIZE
// feature from above (<=).
export function defaultOpForFeature(id: string): "<=" | ">=" {
  const feature = CONSTRAINABLE_FEATURE_BY_ID.get(id);
  return feature?.direction === "minimize" ? "<=" : ">=";
}

export function defaultValueForFeature(id: string): number {
  return CONSTRAINABLE_FEATURE_BY_ID.get(id)?.defaultValue ?? 0;
}
