"""Resolve the RQ1 BIM instances through the OpenBinding gateway, unchanged.

Sends every scripts/experiments/bim/fms_*.json instance, as-is, to OpenBinding
and checks the returned binding against the offline oracle
(verify_bim_instances.py): the binding must satisfy every hard constraint and
reach the oracle's optimal objective value. An instance can have several
optimal bindings (e.g. the two-task scenario's symmetric sub-circuits), so a
binding that differs from the oracle's but ties on the optimum is reported as
OK (tie). Needs network access to the OpenBinding gateway (default:
https://openbinding.score.us.es/api, override with OPENBINDING_URL); no
provider credentials are needed.

Usage: uv run python scripts/experiments/solve_bim_instances.py
"""

from __future__ import annotations

import json
import math
import os
import sys
from pathlib import Path

from openbinding import Instance, OpenBindingClient
from openbinding.client import DEFAULT_BASE_URL

sys.path.insert(0, str(Path(__file__).resolve().parent))
from verify_bim_instances import BIM_DIR, aggregate, satisfies, solve  # noqa: E402

ENGINE = "minizinc-csp"


def main() -> int:
    base_url = os.environ.get("OPENBINDING_URL", DEFAULT_BASE_URL)
    mismatches = 0
    with OpenBindingClient(base_url=base_url) as client:
        for path in sorted(BIM_DIR.glob("fms_*.json")):
            raw = json.loads(path.read_text())
            result = client.solve(ENGINE, Instance.model_validate(raw))
            returned = [result.solutions[0].binding[t["id"]] for t in raw["tasks"]]
            oracle, oracle_value = solve(raw)

            by_id = {c["id"]: c for c in raw["candidates"]}
            binding = tuple(by_id[cid] for cid in returned)
            (target,) = raw["objective"]["targets"]
            value = aggregate(raw, target, [c["features"][target] for c in binding])
            optimal = satisfies(raw, binding) and math.isclose(value, oracle_value, rel_tol=1e-9)

            mismatches += not optimal
            status = ("OK  " if returned == oracle else "OK (tie)") if optimal else "DIFF"
            print(f"{status:8s} {path.name:36s} OpenBinding -> {', '.join(returned)}  "
                  f"{target} = {value:g}  ({result.provenance.execution_time_ms} ms)")
            if returned != oracle:
                print(f"{'':8s} {'':36s} oracle      -> {', '.join(oracle)}  "
                      f"{target} = {oracle_value:g}")
    return 1 if mismatches else 0


if __name__ == "__main__":
    sys.exit(main())
