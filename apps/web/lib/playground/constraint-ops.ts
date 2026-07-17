// Matches openbinding.models.ConstraintOp (minus IN_RANGE — two rows on
// the same feature already cover a range without a two-value widget, see
// task-specification-panel.tsx's Constraints section).
export type ConstraintOp = "<=" | ">=" | "==" | "<" | ">";

export const CONSTRAINT_OPS: { value: ConstraintOp; label: string }[] = [
  { value: "<=", label: "≤" },
  { value: ">=", label: "≥" },
  { value: "==", label: "=" },
  { value: "<", label: "<" },
  { value: ">", label: ">" },
];
