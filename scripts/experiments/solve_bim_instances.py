"""Resolve the RQ1 BIM instances through the OpenBinding gateway, unchanged.

Sends every scripts/experiments/bim/fms_*.json instance, as-is, to OpenBinding
and prints the returned binding next to the offline oracle's answer
(verify_bim_instances.py). Needs network access to the OpenBinding gateway
(default: https://openbinding.score.us.es/api, override with
OPENBINDING_URL); no provider credentials are needed.

Usage: uv run python scripts/experiments/solve_bim_instances.py
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from openbinding import Instance, OpenBindingClient
from openbinding.client import DEFAULT_BASE_URL

sys.path.insert(0, str(Path(__file__).resolve().parent))
from verify_bim_instances import BIM_DIR, solve  # noqa: E402

ENGINE = "minizinc-csp"


def main() -> int:
    base_url = os.environ.get("OPENBINDING_URL", DEFAULT_BASE_URL)
    mismatches = 0
    with OpenBindingClient(base_url=base_url) as client:
        for path in sorted(BIM_DIR.glob("fms_*.json")):
            raw = json.loads(path.read_text())
            result = client.solve(ENGINE, Instance.model_validate(raw))
            returned = [result.solutions[0].binding[t["id"]] for t in raw["tasks"]]
            oracle, _ = solve(raw)
            same = returned == oracle
            mismatches += not same
            print(f"{'OK  ' if same else 'DIFF'} {path.name:36s} OpenBinding -> "
                  f"{', '.join(returned)}  ({result.provenance.execution_time_ms} ms)")
    return 1 if mismatches else 0


if __name__ == "__main__":
    sys.exit(main())
