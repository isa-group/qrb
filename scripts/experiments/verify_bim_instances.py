"""Offline oracle for the RQ1 BIM instances (no network, no credentials).

For every instance in scripts/experiments/bim/fms_*.json, enumerates the full
binding space B = prod_t C_t, discards bindings that violate a hard constraint
(local bounds per candidate, global bounds on the aggregated value), aggregates
the objective feature along the composition with the instance's own
aggregation policy, and prints the optimal binding. The expected bindings are
the ones stated in Section 3 of the paper; the script exits non-zero if any
differs.

Usage: uv run python scripts/experiments/verify_bim_instances.py
"""

from __future__ import annotations

import itertools
import json
import math
import sys
from pathlib import Path

BIM_DIR = Path(__file__).resolve().parent / "bim"

EXPECTED = {
    "fms_single_task_cost.json": ["cand_garnet_iqm"],
    "fms_single_task_queue.json": ["cand_garnet_aws"],
    "fms_single_task_fidelity.json": ["cand_h2_azure"],
    "fms_two_task_cost.json": ["cand_t1_garnet_iqm", "cand_t2_garnet_iqm"],
    "fms_two_task_queue.json": ["cand_t1_garnet_aws", "cand_t2_garnet_aws"],
    "fms_two_task_fidelity_budget.json": ["cand_t1_garnet_iqm", "cand_t2_h2_azure"],
}

AGG = {"SUM": sum, "PRODUCT": math.prod, "MAX": max, "MIN": min}
OPS = {">=": lambda a, b: a >= b, "<=": lambda a, b: a <= b, ">": lambda a, b: a > b,
       "<": lambda a, b: a < b, "==": lambda a, b: a == b}


def aggregate(instance: dict, feature: str, values: list[float]) -> float:
    if len(values) == 1:
        return values[0]
    fn = instance["aggregation_policies"][feature]["compose"]["and"]["fn"]
    return AGG[fn](values)


def satisfies(instance: dict, binding: tuple[dict, ...]) -> bool:
    for c in instance["constraints"]:
        if not c.get("hard", True):
            continue
        attr, op, bound = c["attribute_id"], OPS[c["op"]], c["value"]
        values = [cand["features"][attr] for cand in binding]
        if attr in {"num_qubits", "operational", "real_device"}:
            # capacity / availability / hardware requirements hold per offering
            if not all(op(v, bound) for v in values):
                return False
        elif not op(aggregate(instance, attr, values), bound):
            return False
    return True


def solve(instance: dict) -> tuple[list[str], float]:
    (target,) = instance["objective"]["targets"]
    feature = next(f for f in instance["features"] if f["id"] == target)
    sign = 1 if feature["direction"] == "MAXIMIZE" else -1
    per_task = [[c for c in instance["candidates"] if c["task_id"] == t["id"]]
                for t in instance["tasks"]]
    best: tuple[float, list[str], float] | None = None
    for binding in itertools.product(*per_task):
        if not satisfies(instance, binding):
            continue
        value = aggregate(instance, target, [c["features"][target] for c in binding])
        if best is None or sign * value > best[0]:
            best = (sign * value, [c["id"] for c in binding], value)
    assert best is not None, "no feasible binding"
    return best[1], best[2]


def main() -> int:
    failures = 0
    for path in sorted(BIM_DIR.glob("fms_*.json")):
        instance = json.loads(path.read_text())
        binding, value = solve(instance)
        ok = binding == EXPECTED[path.name]
        failures += not ok
        names = {c["id"]: c["name"] for c in instance["candidates"]}
        print(f"{'OK  ' if ok else 'FAIL'} {path.name:36s} "
              f"{instance['objective']['targets'][0]:>8s} = {value:<6g} -> "
              + " + ".join(names[b] for b in binding))
    print(f"\n{len(EXPECTED) - failures}/{len(EXPECTED)} instances match the paper.")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
