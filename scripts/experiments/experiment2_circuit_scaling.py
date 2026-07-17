"""Experiment 2 — Circuit-Driven Stages

How do transpilation, feature computation, instance build, and OpenBinding
resolution scale with circuit size? Uses the frozen catalog snapshot from
capture_snapshot.py — no ingestion calls happen in this script at all, only
qubit-scaling of computation (real transpilation/features) plus one real
remote OpenBinding resolve per run.

Usage: uv run python scripts/experiments/experiment2_circuit_scaling.py [--pilot] [--reps N]
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

from mqt.bench import BenchmarkLevel, get_benchmark

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import (  # noqa: E402
    ALL_FEATURE_COLUMNS,
    SHARED_SNAPSHOT_PATH,
    ensure_output_dir,
    feature_columns_for,
    utc_timestamp,
    write_csv,
)
from qrb.instance import build_instance  # noqa: E402
from qrb.preferences import resolve_preferences  # noqa: E402
from qrb.select import select_from_instance  # noqa: E402
from qrb.snapshot import load_snapshot  # noqa: E402

FAMILIES = ["ghz", "qaoa", "randomcircuit"]
QUBIT_POINTS = [2, 4, 8, 12, 15, 20, 28, 36, 53, 65, 84, 107, 156]
"""Log-ish spacing across the real catalog's range (max physical qubit
count is 156, uniform across all 6 IBM devices; Braket tops out at 107).
Includes 15 to connect with Experiment 3's QAOA circuit and 156 as the true
catalog max."""
REPS = 10
PRESET = "balanced"
"""Experiment 2 measures computational cost, not preference outcomes — any
concrete, operational-constrained preset works; 'balanced' is the app's
actual default."""


def selected_candidate_id(response) -> str | None:
    if not response.solutions:
        return None
    return next(iter(response.solutions[0].binding.values()), None)


def run_one(circuit, resources, preferences) -> tuple[dict, list[dict]]:
    instance, timings = build_instance(circuit, resources, preferences)
    candidates_by_id = {c.id: c.features for c in instance.candidates}

    t0 = time.perf_counter()
    response = select_from_instance(instance, preferences)
    resolution_ms = (time.perf_counter() - t0) * 1000

    n_feasible = sum(
        1
        for r in resources
        if timings.per_resource.get(r.candidate_id, {}).get("depth_post") is not None
    )
    instance_build_ms = timings.total_ms

    summary = {
        "n_candidates_total": len(resources),
        "n_feasible": n_feasible,
        "preprocessing_ms": round(timings.preprocessing_ms, 3),
        "instance_build_ms": round(instance_build_ms, 3),
        "resolution_ms": round(resolution_ms, 3),
        "end_to_end_ms": round(instance_build_ms + resolution_ms, 3),
        "selected_candidate_id": selected_candidate_id(response),
    }

    raw_rows = []
    for resource in resources:
        per_res = timings.per_resource.get(resource.candidate_id, {})
        depth_post = per_res.get("depth_post")
        row = {
            "candidate_id": resource.candidate_id,
            "feasible": depth_post is not None,
            "depth_pre": per_res.get("depth_pre"),
            "depth_post": depth_post,
            "transpilation_ms": per_res.get("transpile_ms"),
            "feature_computation_ms": per_res.get("features_ms"),
            **feature_columns_for(candidates_by_id.get(resource.candidate_id)),
        }
        raw_rows.append(row)

    return summary, raw_rows


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pilot", action="store_true", help="N=2, one family, ~4 qubit points.")
    parser.add_argument("--reps", type=int, default=None)
    parser.add_argument("--families", default=None, help="Comma-separated, e.g. ghz,qaoa")
    parser.add_argument("--qubits", default=None, help="Comma-separated qubit points.")
    parser.add_argument("--snapshot", default=None)
    args = parser.parse_args()

    if args.pilot:
        families, qubit_points, reps = ["ghz"], [2, 15, 53, 156], (args.reps or 2)
    else:
        families = args.families.split(",") if args.families else FAMILIES
        qubit_points = [int(q) for q in args.qubits.split(",")] if args.qubits else QUBIT_POINTS
        reps = args.reps or REPS

    snapshot_path = Path(args.snapshot) if args.snapshot else SHARED_SNAPSHOT_PATH
    resources = load_snapshot(snapshot_path)
    preferences = resolve_preferences(preset=PRESET)

    summary_rows = []
    raw_rows_all = []
    total = len(families) * len(qubit_points) * reps
    n = 0
    for family in families:
        for qubits in qubit_points:
            for repetition in range(1, reps + 1):
                n += 1
                circuit = get_benchmark(family, BenchmarkLevel.ALG, qubits)
                summary, raw_rows = run_one(circuit, resources, preferences)
                ts = utc_timestamp()

                print(
                    f"[{n}/{total}] {family}@{qubits}q rep={repetition}: "
                    f"n_feasible={summary['n_feasible']}/{summary['n_candidates_total']} "
                    f"end_to_end_ms={summary['end_to_end_ms']:.1f} "
                    f"winner={summary['selected_candidate_id']}",
                    flush=True,
                )

                summary_rows.append(
                    {
                        "family": family,
                        "qubits": qubits,
                        "repetition": repetition,
                        **summary,
                        "timestamp": ts,
                    }
                )
                for row in raw_rows:
                    raw_rows_all.append(
                        {
                            "family": family,
                            "qubits": qubits,
                            "repetition": repetition,
                            **row,
                            "timestamp": ts,
                        }
                    )

    out_dir = ensure_output_dir()
    write_csv(
        out_dir / "experiment2_per_candidate.csv",
        [
            "family",
            "qubits",
            "repetition",
            "candidate_id",
            "feasible",
            "depth_pre",
            "depth_post",
            "transpilation_ms",
            "feature_computation_ms",
            *ALL_FEATURE_COLUMNS,
            "timestamp",
        ],
        raw_rows_all,
    )
    write_csv(
        out_dir / "experiment2_per_run_summary.csv",
        [
            "family",
            "qubits",
            "repetition",
            "n_candidates_total",
            "n_feasible",
            "preprocessing_ms",
            "instance_build_ms",
            "resolution_ms",
            "end_to_end_ms",
            "selected_candidate_id",
            "timestamp",
        ],
        summary_rows,
    )
    print(
        f"\nWrote {len(raw_rows_all)} per-candidate rows and {len(summary_rows)} per-run rows to {out_dir}"
    )


if __name__ == "__main__":
    main()
