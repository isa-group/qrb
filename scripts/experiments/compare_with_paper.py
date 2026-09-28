"""Compare a re-run of Experiments 2 and 3 with the data reported in the paper.

Both runs use the same frozen snapshot, so feasible sets and selected bindings
must be identical; only timings may differ. For every configuration present in
the re-run (all of them, or the pilot subset), checks:
  - Experiment 2: number of feasible candidates and selected binding;
  - Experiment 3: selected binding for each preference weighting.

Usage: uv run python scripts/experiments/compare_with_paper.py [RERUN_DIR]
       (default RERUN_DIR: $QRB_EXPERIMENTS_OUT, else scripts/experiments/rerun)
"""

from __future__ import annotations

import csv
import os
import sys
from pathlib import Path

PAPER = Path(__file__).resolve().parent / "output"


def load(path: Path) -> list[dict]:
    with path.open() as f:
        return list(csv.DictReader(f))


def compare(rerun: Path) -> int:
    mismatches = checked = 0

    exp2 = rerun / "experiment2_per_run_summary.csv"
    if exp2.exists():
        paper = {(r["family"], r["qubits"], r["repetition"]): r
                 for r in load(PAPER / "experiment2_per_run_summary.csv")}
        for r in load(exp2):
            ref = paper.get((r["family"], r["qubits"], r["repetition"]))
            if ref is None:
                continue
            checked += 1
            if (r["n_feasible"], r["selected_candidate_id"]) != (
                    ref["n_feasible"], ref["selected_candidate_id"]):
                mismatches += 1
                print(f"DIFF exp2 {r['family']} {r['qubits']}q rep{r['repetition']}: "
                      f"{r['n_feasible']} feasible -> {r['selected_candidate_id']} "
                      f"(paper: {ref['n_feasible']} -> {ref['selected_candidate_id']})")

    exp3 = rerun / "experiment3_ternary.csv"
    if exp3.exists():
        paper = {r["config_name"]: r["selected_candidate_id"]
                 for r in load(PAPER / "experiment3_ternary.csv")}
        for r in load(exp3):
            if r["config_name"] not in paper:
                continue
            checked += 1
            if r["selected_candidate_id"] != paper[r["config_name"]]:
                mismatches += 1
                print(f"DIFF exp3 {r['config_name']}: {r['selected_candidate_id']} "
                      f"(paper: {paper[r['config_name']]})")

    if checked == 0:
        print(f"No re-run data found in {rerun}.")
        return 1
    print(f"{checked - mismatches}/{checked} re-run configurations match the paper "
          "(feasible sets and selected bindings).")
    return 1 if mismatches else 0


if __name__ == "__main__":
    default = os.environ.get("QRB_EXPERIMENTS_OUT", "scripts/experiments/rerun")
    sys.exit(compare(Path(sys.argv[1] if len(sys.argv) > 1 else default).resolve()))
