// Renormalizes the other active weights proportionally to their previous
// relative share whenever one slider moves, keeping the set summing to 1
// without the user ever having to balance it by hand. Falls back to an
// even split if the others were all at 0 (nothing to be proportional to).
export function redistributeWeights(
  current: Record<string, number>,
  changedId: string,
  rawValue: number
): Record<string, number> {
  const newValue = Math.min(1, Math.max(0, rawValue));
  const others = Object.keys(current).filter((id) => id !== changedId);
  const next: Record<string, number> = { [changedId]: newValue };
  if (others.length === 0) return next;

  const remaining = 1 - newValue;
  const othersSum = others.reduce((sum, id) => sum + current[id], 0);
  let allocated = 0;
  others.forEach((id, index) => {
    if (index === others.length - 1) {
      // Last one absorbs the rounding remainder so the total is exact,
      // not just approximately 1.
      next[id] = Math.max(0, remaining - allocated);
      return;
    }
    const share =
      othersSum > 0
        ? (current[id] / othersSum) * remaining
        : remaining / others.length;
    next[id] = share;
    allocated += share;
  });
  return next;
}

// Adds a new criterion by taking an even share from every existing one
// (including the new one), so the set stays summed to 1 immediately.
export function addCriterion(
  current: Record<string, number>,
  id: string
): Record<string, number> {
  const ids = [...Object.keys(current), id];
  const even = 1 / ids.length;
  return Object.fromEntries(ids.map((k) => [k, even]));
}

// Removes a criterion and redistributes its share proportionally among
// the rest; falls back to an even split if the rest were all at 0.
export function removeCriterion(
  current: Record<string, number>,
  id: string
): Record<string, number> {
  const rest = Object.fromEntries(
    Object.entries(current).filter(([key]) => key !== id)
  );
  const remainingIds = Object.keys(rest);
  if (remainingIds.length === 0) return rest;
  const restSum = remainingIds.reduce((sum, k) => sum + rest[k], 0);
  if (restSum <= 0) {
    const even = 1 / remainingIds.length;
    return Object.fromEntries(remainingIds.map((k) => [k, even]));
  }
  return Object.fromEntries(
    remainingIds.map((k) => [k, rest[k] / restSum])
  );
}
