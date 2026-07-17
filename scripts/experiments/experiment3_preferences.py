"""Experiment 3 — Preference-Dependent Outcomes

Does the same catalog snapshot yield different optimal bindings under
different declared preferences?

Fixed task: the QAOA circuit from the FMS/routing running example (15
qubits). Fixed catalog: the frozen snapshot shared with Experiment 2.
Features are transpiled/computed exactly once against that snapshot; the
ternary sweep (~66 weight combinations over cost/fidelity/queue, step 0.1)
then only re-solves — no re-transpilation, no re-fetching. This script
deliberately does not call qrb.instance.build_instance() per weight
combo (that would re-transpile every time); instead it reconstructs
build_instance()'s tail (Candidate/Instance assembly) directly, reusing
the precomputed feature set and only swapping the Objective per
combination.

Usage: uv run python scripts/experiments/experiment3_preferences.py [--pilot]
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from mqt.bench import BenchmarkLevel, get_benchmark
from openbinding import (
    AggregationPolicy,
    AttributeBoundConstraint,
    Candidate,
    Compose,
    ComposeFn,
    ComposeFnName,
    ConstraintOp,
    Instance,
    InstanceMetadata,
    ProviderRef,
    StructuredTree,
    TaskNode,
    TaskRef,
)

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import (  # noqa: E402
    ALL_FEATURE_COLUMNS,
    SHARED_SNAPSHOT_PATH,
    ensure_output_dir,
    feature_columns_for,
    write_csv,
)
from qrb.circuit import width as circuit_width  # noqa: E402
from qrb.features import (  # noqa: E402
    FEATURE_REGISTRY,
    OBJECTIVE_FEATURE_IDS,
    compute_candidate_features,
    compute_normalized_objective_features,
    normalized_feature_spec,
)
from qrb.instance import FEASIBILITY_CONSTRAINT_ID, PROVIDER_DISPLAY_NAMES, TASK_ID  # noqa: E402
from qrb.preferences import Preferences  # noqa: E402
from qrb.presets import ConstraintSpec  # noqa: E402
from qrb.select import select_from_instance  # noqa: E402
from qrb.snapshot import load_snapshot  # noqa: E402
from qrb.transpile import (  # noqa: E402
    DEFAULT_OPTIMIZATION_LEVEL,
    DEFAULT_TRANSPILER_SEED,
    transpile_for_resource,
)

QAOA_QUBITS = 15
SHOTS = 1024
REQUIRE_OPERATIONAL = [ConstraintSpec("operational", ConstraintOp.GE, 1.0)]


def build_static_instance_parts(circuit, resources):
    """The build_instance()-tail equivalent, computed exactly once: real
    transpilation + feature computation per candidate, then the
    Candidate/Feature/AggregationPolicy/Constraint pieces that do NOT
    depend on which preferences will later be resolved against them."""
    width = circuit_width(circuit)

    per_candidate = []
    for resource in resources:
        tr = transpile_for_resource(
            circuit,
            resource,
            optimization_level=DEFAULT_OPTIMIZATION_LEVEL,
            seed=DEFAULT_TRANSPILER_SEED,
        )
        raw = compute_candidate_features(resource, tr, SHOTS)
        per_candidate.append((resource, tr, raw))

    raw_features_by_resource = [raw for _, _, raw in per_candidate]
    normalized_by_resource = compute_normalized_objective_features(raw_features_by_resource)

    candidates = [
        Candidate(
            id=resource.candidate_id,
            task_id=TASK_ID,
            provider_id=resource.provider_id,
            name=resource.name,
            features={**raw, **normalized},
        )
        for (resource, tr, raw), normalized in zip(per_candidate, normalized_by_resource)
        if tr.infeasible_reason != "transpile_error"
    ]
    if not candidates:
        raise ValueError("No resource could successfully transpile this circuit.")

    provider_ids = sorted({r.provider_id for r in resources})
    providers = [
        ProviderRef(id=pid, name=PROVIDER_DISPLAY_NAMES.get(pid, pid)) for pid in provider_ids
    ]

    all_feature_specs = [
        *FEATURE_REGISTRY,
        *(normalized_feature_spec(fid) for fid in OBJECTIVE_FEATURE_IDS),
    ]
    features_decl = [spec.to_bim_feature() for spec in all_feature_specs]
    aggregation_policies = {
        spec.id: AggregationPolicy(
            neutral=0.0, compose=Compose(seq=ComposeFn(fn=ComposeFnName.SUM))
        )
        for spec in all_feature_specs
    }
    feasibility_constraint = AttributeBoundConstraint(
        id=FEASIBILITY_CONSTRAINT_ID,
        scope="GLOBAL",
        attribute_id="num_qubits",
        op=ConstraintOp.GE,
        value=float(width),
        hard=True,
    )

    return {
        "candidates": candidates,
        "candidates_by_id": {c.id: c.features for c in candidates},
        "feasible_by_id": {resource.candidate_id: tr.feasible for resource, tr, _ in per_candidate},
        "providers": providers,
        "features_decl": features_decl,
        "aggregation_policies": aggregation_policies,
        "feasibility_constraint": feasibility_constraint,
    }


def make_instance(static: dict, preferences: Preferences) -> Instance:
    constraints = [static["feasibility_constraint"], *preferences.to_constraints()]
    return Instance(
        metadata=InstanceMetadata(
            id=str(uuid4()),
            name="qrb-experiment3",
            version="0.1",
            created_at=datetime.now(timezone.utc),
        ),
        providers=static["providers"],
        tasks=[TaskRef(id=TASK_ID, name="Quantum circuit execution")],
        candidates=static["candidates"],
        features=static["features_decl"],
        composition=StructuredTree(root=TaskNode(id="root", task_id=TASK_ID)),
        aggregation_policies=static["aggregation_policies"],
        constraints=constraints,
        objective=preferences.to_objective(),
    )


def selected_candidate_id(response) -> str | None:
    if not response.solutions:
        return None
    return next(iter(response.solutions[0].binding.values()), None)


def ternary_grid(n: int) -> list[tuple[int, int, int]]:
    """Integer (i, j, k) with i+j+k == n — weights are i/n, j/n, k/n over
    (cost, fidelity, queue). n=10 -> 66 combinations (step 0.1)."""
    combos = []
    for i in range(n + 1):
        for j in range(n + 1 - i):
            k = n - i - j
            combos.append((i, j, k))
    return combos


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--pilot",
        action="store_true",
        help="Small ternary grid (n=3, 10 combos) instead of n=10 (66).",
    )
    parser.add_argument("--snapshot", default=None)
    args = parser.parse_args()

    n = 3 if args.pilot else 10
    snapshot_path = Path(args.snapshot) if args.snapshot else SHARED_SNAPSHOT_PATH
    resources = load_snapshot(snapshot_path)

    print(f"Generating QAOA@{QAOA_QUBITS}q (mqt.bench, ALG level)...")
    circuit = get_benchmark("qaoa", BenchmarkLevel.ALG, QAOA_QUBITS)

    print("Transpiling + computing features once against the frozen snapshot...")
    static = build_static_instance_parts(circuit, resources)
    print(f"  {len(static['candidates'])}/{len(resources)} candidates feasible.")

    combos = ternary_grid(n)
    print(f"Ternary sweep: {len(combos)} weight combinations (n={n})...")

    rows = []
    for idx, (i, j, k) in enumerate(combos, start=1):
        w_cost, w_fidelity, w_queue = i / n, j / n, k / n
        preferences = Preferences(
            weights={"cost": w_cost, "expected_fidelity": w_fidelity, "queue": w_queue},
            constraints=REQUIRE_OPERATIONAL,
        )
        instance = make_instance(static, preferences)
        response = select_from_instance(instance, preferences)
        winner = selected_candidate_id(response)
        print(
            f"[{idx}/{len(combos)}] cost={w_cost:.1f} fidelity={w_fidelity:.1f} queue={w_queue:.1f} -> {winner}"
        )

        rows.append(
            {
                "config_name": f"w_cost={w_cost:.1f},w_fidelity={w_fidelity:.1f},w_queue={w_queue:.1f}",
                "w_cost": w_cost,
                "w_fidelity": w_fidelity,
                "w_queue": w_queue,
                "selected_candidate_id": winner,
                **feature_columns_for(static["candidates_by_id"].get(winner)),
            }
        )

    # Determinism check: re-run one configuration's resolution twice
    # against the same already-built Instance (no re-fetch, no rebuild).
    check_prefs = Preferences(
        weights={"cost": 0.34, "expected_fidelity": 0.33, "queue": 0.33},
        constraints=REQUIRE_OPERATIONAL,
    )
    check_instance = make_instance(static, check_prefs)
    first = selected_candidate_id(select_from_instance(check_instance, check_prefs))
    second = selected_candidate_id(select_from_instance(check_instance, check_prefs))
    print(
        f"\nDeterminism check (same Instance, resolved twice): {first} == {second} -> {first == second}"
    )

    out_dir = ensure_output_dir()
    write_csv(
        out_dir / "experiment3_ternary.csv",
        [
            "config_name",
            "w_cost",
            "w_fidelity",
            "w_queue",
            "selected_candidate_id",
            *ALL_FEATURE_COLUMNS,
        ],
        rows,
    )
    print(f"\nWrote {len(rows)} rows to {out_dir / 'experiment3_ternary.csv'}")

    candidate_rows = [
        {
            "candidate_id": resource.candidate_id,
            "feasible": static["feasible_by_id"].get(resource.candidate_id, False),
            **feature_columns_for(static["candidates_by_id"].get(resource.candidate_id)),
        }
        for resource in resources
    ]
    write_csv(
        out_dir / "experiment3_candidate_features.csv",
        ["candidate_id", "feasible", *ALL_FEATURE_COLUMNS],
        candidate_rows,
    )
    print(f"Wrote {len(candidate_rows)} rows to {out_dir / 'experiment3_candidate_features.csv'}")


if __name__ == "__main__":
    main()
