"""Optimality-oracle validation

Independently recomputes the argmax of the declared (weighted, normalized)
objective from the already-saved feature tables, and compares it against
the candidate OpenBinding actually returned — for every Experiment 3
configuration (66) and one repetition per Experiment 2 configuration (39).

Only candidates with feasible == True are considered for the argmax, since
the solver enforces the num_qubits feasibility constraint as hard: an
infeasible candidate can never be the returned binding regardless of its
(placeholder) feature values.

Usage: uv run python scripts/experiments/optimality_check.py
"""

from __future__ import annotations

import csv
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import ensure_output_dir, write_csv  # noqa: E402

EXPERIMENT2_PRESET_WEIGHTS = {"expected_fidelity": 0.34, "cost": 0.33, "queue": 0.33}
"""Matches PRESET = "balanced" in experiment2_circuit_scaling.py."""

_NORMALIZED_SUFFIX = "_normalized"


def read_csv(path: Path) -> list[dict]:
    with path.open(newline="") as f:
        return list(csv.DictReader(f))


def argmax_candidate(
    candidates: list[dict], weights: dict[str, float]
) -> tuple[str | None, float, bool]:
    """Returns (winner_candidate_id, winning_value, was_tied) over only the
    candidates admissible under both hard constraints every experiment
    configuration declares — feasible (num_qubits >= circuit width) and
    operational >= 1 — using each candidate's already-computed
    *_normalized feature columns (the same ones qrb sent OpenBinding as
    the objective target)."""
    feasible = [
        c for c in candidates if c["feasible"] in ("True", True) and float(c["operational"]) >= 1.0
    ]
    if not feasible:
        return None, 0.0, False

    scored = []
    for c in feasible:
        value = sum(
            weight * float(c[f"{feature_id}{_NORMALIZED_SUFFIX}"])
            for feature_id, weight in weights.items()
        )
        scored.append((c["candidate_id"], value))

    best_value = max(v for _, v in scored)
    winners = [cid for cid, v in scored if abs(v - best_value) < 1e-9]
    tied = len(winners) > 1
    # Deterministic tie-break for reporting purposes only (alphabetical) —
    # OpenBinding's own tie-break policy is opaque to us; a tie is recorded
    # as a match if the actual winner is ANY of the tied best candidates.
    return sorted(winners)[0], best_value, tied


def check_experiment3(out_dir: Path) -> list[dict]:
    ternary_path = out_dir / "experiment3_ternary.csv"
    features_path = out_dir / "experiment3_candidate_features.csv"
    if not ternary_path.exists() or not features_path.exists():
        print(f"skip experiment3: {ternary_path} or {features_path} not found")
        return []

    candidates = read_csv(features_path)
    rows = read_csv(ternary_path)

    results = []
    for row in rows:
        weights = {
            "cost": float(row["w_cost"]),
            "expected_fidelity": float(row["w_fidelity"]),
            "queue": float(row["w_queue"]),
        }
        winner, value, tied = argmax_candidate(candidates, weights)
        actual = row["selected_candidate_id"] or None
        match = winner is not None and (
            winner == actual or (tied and _is_tied_winner(candidates, weights, value, actual))
        )
        results.append(
            {
                "source": "experiment3",
                "config": row["config_name"],
                "computed_argmax": winner,
                "objective_value": round(value, 6),
                "tied": tied,
                "actual_selected": actual,
                "match": match,
            }
        )
    return results


def _is_tied_winner(candidates, weights, best_value, actual_candidate_id) -> bool:
    if actual_candidate_id is None:
        return False
    for c in candidates:
        if (
            c["candidate_id"] != actual_candidate_id
            or c["feasible"] not in ("True", True)
            or float(c["operational"]) < 1.0
        ):
            continue
        value = sum(
            weight * float(c[f"{feature_id}{_NORMALIZED_SUFFIX}"])
            for feature_id, weight in weights.items()
        )
        return abs(value - best_value) < 1e-9
    return False


def check_experiment2(out_dir: Path, repetition: int = 1) -> list[dict]:
    candidate_path = out_dir / "experiment2_per_candidate.csv"
    summary_path = out_dir / "experiment2_per_run_summary.csv"
    if not candidate_path.exists() or not summary_path.exists():
        print(f"skip experiment2: {candidate_path} or {summary_path} not found")
        return []

    candidate_rows = read_csv(candidate_path)
    summary_rows = read_csv(summary_path)

    by_run: dict[tuple[str, int, int], list[dict]] = {}
    for row in candidate_rows:
        key = (row["family"], int(row["qubits"]), int(row["repetition"]))
        by_run.setdefault(key, []).append(row)

    results = []
    for row in summary_rows:
        if int(row["repetition"]) != repetition:
            continue
        key = (row["family"], int(row["qubits"]), repetition)
        candidates = by_run.get(key, [])
        winner, value, tied = argmax_candidate(candidates, EXPERIMENT2_PRESET_WEIGHTS)
        actual = row["selected_candidate_id"] or None
        match = winner is not None and (
            winner == actual
            or (tied and _is_tied_winner(candidates, EXPERIMENT2_PRESET_WEIGHTS, value, actual))
        )
        results.append(
            {
                "source": "experiment2",
                "config": f"{row['family']}@{row['qubits']}q",
                "computed_argmax": winner,
                "objective_value": round(value, 6),
                "tied": tied,
                "actual_selected": actual,
                "match": match,
            }
        )
    return results


def main() -> None:
    out_dir = ensure_output_dir()
    results = [*check_experiment3(out_dir), *check_experiment2(out_dir)]

    if not results:
        print("Nothing to check — no experiment CSVs found.")
        return

    n_match = sum(1 for r in results if r["match"])
    n_tied = sum(1 for r in results if r["tied"])
    by_source: dict[str, list[dict]] = {}
    for r in results:
        by_source.setdefault(r["source"], []).append(r)

    for source, rows in by_source.items():
        matched = sum(1 for r in rows if r["match"])
        print(f"{source}: {matched}/{len(rows)} matched")
        for r in rows:
            if not r["match"]:
                print(
                    f"  MISMATCH {r['config']}: argmax={r['computed_argmax']} actual={r['actual_selected']}"
                )

    print(f"\nTotal: {n_match}/{len(results)} matched ({n_tied} configurations had a tie).")

    write_csv(
        out_dir / "optimality_check.csv",
        [
            "source",
            "config",
            "computed_argmax",
            "objective_value",
            "tied",
            "actual_selected",
            "match",
        ],
        results,
    )
    print(f"Wrote {len(results)} rows to {out_dir / 'optimality_check.csv'}")


if __name__ == "__main__":
    main()
