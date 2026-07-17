// Mirrors qrb.features.OBJECTIVE_FEATURE_IDS — the features a
// Preferences.weights dict may reference. Kept in sync by hand; this list
// is small and changes as rarely as the backend's own weightable feature
// set (adding one is a real feature addition, not routine content).
export interface ObjectiveFeature {
  id: string;
  label: string;
  description: string;
}

export const OBJECTIVE_FEATURES: ObjectiveFeature[] = [
  {
    id: "expected_fidelity",
    label: "Expected fidelity",
    description: "Product of per-gate and readout fidelities. Higher is better.",
  },
  {
    id: "cost",
    label: "Cost",
    description: "Estimated execution cost in USD. Lower is better.",
  },
  {
    id: "queue",
    label: "Queue length",
    description: "Pending jobs ahead of yours. Lower is better.",
  },
  {
    id: "critical_depth",
    label: "Critical depth",
    description:
      "Share of 2-qubit gates on the compiled circuit's critical path (MQT Predictor). Lower is more parallel, better.",
  },
  {
    id: "estimated_success_probability",
    label: "Estimated success probability",
    description:
      "Expected fidelity discounted by T1/T2 decoherence during idle time (MQT Predictor). Higher is better.",
  },
];

export const OBJECTIVE_FEATURE_BY_ID = new Map(
  OBJECTIVE_FEATURES.map((f) => [f.id, f])
);

export function labelForFeature(id: string): string {
  return OBJECTIVE_FEATURE_BY_ID.get(id)?.label ?? id;
}
