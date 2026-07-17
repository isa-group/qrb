import { defaultOpForFeature, defaultValueForFeature } from "./constrainable-features";
import type { ConstraintsFormValue } from "./schema";

// No renormalization needed here (unlike weights) — constraints are
// independent bounds, not proportions that must sum to anything.
export function addConstraint(
  current: ConstraintsFormValue,
  feature: string
): ConstraintsFormValue {
  return {
    ...current,
    [feature]: { op: defaultOpForFeature(feature), value: defaultValueForFeature(feature) },
  };
}

export function removeConstraint(
  current: ConstraintsFormValue,
  feature: string
): ConstraintsFormValue {
  return Object.fromEntries(
    Object.entries(current).filter(([key]) => key !== feature)
  );
}
