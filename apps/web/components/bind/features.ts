import type { Schemas } from "@/lib/api/client";

/** Feature metadata as the API describes it (POST /instance → result.features). */
export type Feature = Schemas["Feature"];
export type Violation = Schemas["ConstraintViolation"];

/** Operators the selector offers. IN_RANGE is left out: a constraint carries a single number. */
export type Op = "<=" | ">=" | "==" | "<" | ">";
export const OPS: Op[] = ["<=", ">=", "==", "<", ">"];
export const OP_WORDS: Record<Op, string> = {
  "<=": "at most",
  ">=": "at least",
  "==": "exactly",
  "<": "less than",
  ">": "more than",
};

/** Built-in constraint QRB adds so a QPU has enough qubits for the circuit. */
export const QUBIT_CONSTRAINT_ID = "feasibility_num_qubits";

const UNIT_LABEL: Record<string, string> = { usd: "USD", pending_jobs: "jobs", hours: "hours" };

export const isBoolean = (f: Feature) => f.unit === "boolean";
export const isNormalized = (f: Feature) => f.unit === "normalized_score" || f.id.endsWith("_normalized");
export const unitLabel = (f: Feature) => UNIT_LABEL[f.unit] ?? "";
export const higherIsBetter = (f: Feature) => f.direction === "MAXIMIZE";

/** "Expected Fidelity" → "Expected fidelity" (sentence case, as the interface writes labels). */
export function label(f: Feature): string {
  const words = f.name.split(" ");
  return words.map((w, i) => (i === 0 || w === w.toUpperCase() ? w : w.toLowerCase())).join(" ");
}

/** Features that can carry a weight: the objective targets each one's normalized companion. */
export function weightable(features: Feature[]): Feature[] {
  const ids = new Set(features.map((f) => f.id));
  return features.filter((f) => !isNormalized(f) && !isBoolean(f) && ids.has(`${f.id}_normalized`));
}

/** Numeric features that can be bounded by a constraint. */
export const constrainable = (features: Feature[]) => features.filter((f) => !isNormalized(f) && !isBoolean(f));
export const booleans = (features: Feature[]) => features.filter((f) => !isNormalized(f) && isBoolean(f));

/** Grouping for the feature picker. Unknown features from a newer API fall into "Other". */
const GROUPS: { name: string; ids: string[] }[] = [
  { name: "Quality", ids: ["expected_fidelity", "estimated_success_probability", "critical_depth"] },
  { name: "Cost and wait", ids: ["cost", "queue"] },
  { name: "Hardware", ids: ["num_qubits", "calibration_age_hours"] },
];
export function grouped(features: Feature[]): { name: string; features: Feature[] }[] {
  const out = GROUPS.map((g) => ({ name: g.name, features: features.filter((f) => g.ids.includes(f.id)) }));
  const known = new Set(GROUPS.flatMap((g) => g.ids));
  out.push({ name: "Other", features: features.filter((f) => !known.has(f.id)) });
  return out.filter((g) => g.features.length > 0);
}

/** Sentence for a yes/no requirement. */
export function booleanSentence(f: Feature): string {
  if (f.id === "operational") return "Must be operational";
  if (f.id === "depth_feasible") return "Circuit depth must fit the QPU";
  return `Must be ${label(f).toLowerCase()}`;
}

/** Input step for a feature's value field. */
export function step(f: Feature): number {
  if (f.unit === "usd") return 0.01;
  if (f.unit === "probability" || f.unit === "ratio") return 0.01;
  return 1;
}

/** The default operator follows what "better" means for the feature. */
export const defaultOp = (f: Feature): Op => (higherIsBetter(f) ? ">=" : "<=");

/** Formats a raw feature value for display, in the feature's own unit. */
export function format(f: Feature | undefined, v: number): string {
  switch (f?.unit) {
    case "usd":
      return v.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
    case "pending_jobs":
    case "count":
      return Math.round(v).toLocaleString("en-US");
    case "hours":
      return v < 10 ? v.toFixed(1) : Math.round(v).toLocaleString("en-US");
    case "boolean":
      return v >= 1 ? "Yes" : "No";
    case "probability":
      return v.toFixed(3);
    default:
      return Number.isInteger(v) ? String(v) : v.toFixed(2);
  }
}

/** Plain-language reason a candidate was excluded, from the API's violation record. */
export function describeViolation(byId: Map<string, Feature>, v: Violation): string {
  const f = byId.get(v.feature);
  const bound = typeof v.value === "number" ? v.value : null;
  if (v.constraint_id === QUBIT_CONSTRAINT_ID && bound !== null) {
    return `Too few qubits for your circuit: has ${format(f, v.actual)}, needs ${format(f, bound)}`;
  }
  if (f && isBoolean(f)) {
    if (f.id === "operational") return "Not operational";
    if (f.id === "depth_feasible") return "Circuit depth does not fit";
    return `${label(f)}: no`;
  }
  const name = f ? label(f) : v.feature;
  const unit = f ? unitLabel(f) : "";
  const op = OP_WORDS[v.op as Op] ?? v.op;
  const limit = bound === null ? "the allowed range" : `${format(f, bound)}${unit && f?.unit !== "usd" ? ` ${unit}` : ""}`;
  const actual = `${format(f, v.actual)}${unit && f?.unit !== "usd" ? ` ${unit}` : ""}`;
  return `${name} must be ${op} ${limit}; has ${actual}`;
}

/** One colour per weightable feature, keyed by id so it is the same wherever it appears. The values
 *  are theme tokens (--feat-<id> in globals.css), so light and dark each get readable colours. */
const COLOURED = new Set(["expected_fidelity", "cost", "queue", "critical_depth", "estimated_success_probability"]);
export const featureColor = (id: string) => (COLOURED.has(id) ? `var(--feat-${id})` : "var(--ink-3)");
