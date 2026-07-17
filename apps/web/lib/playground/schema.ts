import { z } from "zod";

import type { ConstraintOp } from "./constraint-ops";
import { DEFAULT_EXAMPLE_CIRCUIT } from "./example-circuits";

// Loose enough to absorb float drift from repeated slider-driven
// renormalization (see redistributeWeights in task-specification-panel.tsx),
// tight enough to still catch a genuinely broken preset/import.
const WEIGHT_SUM_TOLERANCE = 1e-4;

const constraintOpSchema = z.enum(["<=", ">=", "==", "<", ">"]);

export const taskSpecFormSchema = z
  .object({
    circuitQasm: z.string().min(1, "Circuit is required"),
    shots: z.coerce.number().int().min(1).max(1_000_000),
    providerConstraint: z.enum(["any", "ibm", "braket"]),
    // Generic, declarable-and-selectable constraints — the replacement for
    // the old fixed minFidelity/maxCost/maxQueue/requireOperational/
    // maxCalibrationAgeHours fields. One entry per feature (capped, per
    // the UI's "+ Add constraint" excluding already-used features),
    // mirroring how `weights` is keyed by feature id. Empty is valid —
    // unlike weights, having zero constraints just means "no bounds".
    constraints: z.record(
      z.string(),
      z.object({ op: constraintOpSchema, value: z.number() })
    ),
    // Active weighted criteria only — an id absent here is unweighted, not
    // zero-weighted, matching qrb.preferences.Preferences.to_objective()
    // building targets from weights.keys(). Sliders in the UI keep this
    // renormalized to sum to 1; still checked here since it's also the
    // request body sent verbatim to the API.
    weights: z
      .record(z.string(), z.number().min(0).max(1))
      .refine((w) => Object.keys(w).length >= 1, {
        message: "Pick at least one criterion",
      })
      .refine(
        (w) =>
          Math.abs(Object.values(w).reduce((a, b) => a + b, 0) - 1) <
          WEIGHT_SUM_TOLERANCE,
        { message: "Weights must sum to 1" }
      ),
    pareto: z.boolean(),
    engine: z.string().nullable(),
    // Defaults true — a resolved binding is a real decision, not a
    // browsing view, so it should reflect current queue/status by default.
    // Turning it off lets the Playground reuse the 90s catalog cache for
    // faster iteration when only a preference/constraint changed, not the
    // catalog itself.
    forceRefresh: z.boolean(),
  })
  // openbinding.models.ManyObjective requires >= 3 targets — Multi (Pareto)
  // mode with fewer criteria fails server-side with a raw Pydantic error,
  // so catch it here with a clear message instead.
  .refine((v) => !v.pareto || Object.keys(v.weights).length >= 3, {
    message: "Multi (Pareto) mode needs at least 3 criteria",
    path: ["weights"],
  });

export type TaskSpecFormInput = z.input<typeof taskSpecFormSchema>;
export type TaskSpecFormValues = z.output<typeof taskSpecFormSchema>;
export type ConstraintsFormValue = Record<string, { op: ConstraintOp; value: number }>;

export const DEFAULT_WEIGHTS: Record<string, number> = {
  expected_fidelity: 0.34,
  cost: 0.33,
  queue: 0.33,
};

export const DEFAULT_TASK_SPEC_FORM: TaskSpecFormInput = {
  circuitQasm: DEFAULT_EXAMPLE_CIRCUIT.qasm,
  shots: 1024,
  providerConstraint: "any",
  constraints: {},
  weights: DEFAULT_WEIGHTS,
  pareto: false,
  engine: null,
  forceRefresh: true,
};

// qubit[n] (OpenQASM3) or qreg name[n] (OpenQASM2, in case someone pastes
// legacy syntax) — summed across declarations, matching how a circuit's
// total width is the sum of its qubit registers. Not a real parser; only
// used to drive the live Constraint Inspector (see Question 8/A) — the
// authoritative width comes from the real circuit once actually resolved.
export function deriveCircuitWidth(qasm: string): number | null {
  const matches = qasm.matchAll(/(?:qubit|qreg)\s*(?:\[\s*(\d+)\s*\])?/g);
  let total = 0;
  let found = false;
  for (const match of matches) {
    found = true;
    total += match[1] ? parseInt(match[1], 10) : 1;
  }
  return found && total > 0 ? total : null;
}
