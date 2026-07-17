"""Assemble a BIM Instance from a circuit, a resource catalog, and declared
Preferences. This is the heart of the QACO mapping (Table 1): single Task,
identity aggregation, mandatory feasibility as a hard constraint.
"""

from __future__ import annotations

import time
from datetime import datetime, timezone
from uuid import uuid4

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
from qiskit.circuit import QuantumCircuit

from qrb.circuit import width as circuit_width
from qrb.features import (
    FEATURE_REGISTRY,
    OBJECTIVE_FEATURE_IDS,
    compute_candidate_features,
    compute_normalized_objective_features,
    normalized_feature_spec,
)
from qrb.preferences import Preferences
from qrb.providers.base import ResourceRecord
from qrb.timing import InstanceTimings
from qrb.transpile import (
    DEFAULT_OPTIMIZATION_LEVEL,
    DEFAULT_TRANSPILER_SEED,
    transpile_for_resource,
)

TASK_ID = "task"

PROVIDER_DISPLAY_NAMES = {
    "ibm": "IBM Quantum",
    "braket": "Amazon Braket",
}

FEASIBILITY_CONSTRAINT_ID = "feasibility_num_qubits"


def build_instance(
    circuit: QuantumCircuit,
    resources: list[ResourceRecord],
    preferences: Preferences,
    *,
    shots: int = 1024,
    optimization_level: int = DEFAULT_OPTIMIZATION_LEVEL,
    transpiler_seed: int = DEFAULT_TRANSPILER_SEED,
    instance_name: str = "qrb-selection",
) -> tuple[Instance, InstanceTimings]:
    build_start = time.perf_counter()

    if preferences.require_provider is not None:
        resources = [r for r in resources if r.provider_id == preferences.require_provider]

    provider_ids = sorted({r.provider_id for r in resources})
    providers = [
        ProviderRef(id=pid, name=PROVIDER_DISPLAY_NAMES.get(pid, pid)) for pid in provider_ids
    ]

    # circuit.depth() walks the whole (untranspiled) circuit's DAG — cheap for
    # a shallow circuit but measurable for a dense one. Timed explicitly and
    # surfaced on InstanceTimings rather than left to silently inflate
    # build_instance_ms.
    preprocessing_start = time.perf_counter()
    width = circuit_width(circuit)
    depth_pre = circuit.depth()
    preprocessing_ms = (time.perf_counter() - preprocessing_start) * 1000

    def _features_for(
        resource: ResourceRecord,
    ) -> tuple[dict[str, float], float, float, str | None, int, int | None, int | None]:
        t0 = time.perf_counter()
        tr = transpile_for_resource(
            circuit, resource, optimization_level=optimization_level, seed=transpiler_seed
        )
        t1 = time.perf_counter()
        features = compute_candidate_features(resource, tr, shots)
        t2 = time.perf_counter()
        return (
            features,
            (t1 - t0) * 1000,
            (t2 - t1) * 1000,
            tr.infeasible_reason,
            depth_pre,
            tr.depth,
            tr.num_two_qubit_gates,
        )

    # Deliberately sequential, NOT fanned out via parallel_map — transpile is
    # CPU-bound (Qiskit's Rust-based SABRE router), and concurrent
    # transpilation of a large/dense circuit can hang indefinitely, almost
    # certainly due to lock/cache contention inside Qiskit's transpiler
    # internals. No thread count is provably safe, so this runs sequentially;
    # each resource is cheap on its own, so the total cost is small.
    per_resource_results = [_features_for(resource) for resource in resources]
    raw_features_by_resource = [features for features, *_ in per_resource_results]
    per_resource_timings = {
        resource.candidate_id: {
            "transpile_ms": transpile_ms,
            "features_ms": features_ms,
            "depth_pre": depth_pre,
            "depth_post": depth_post,
            "num_two_qubit_gates": num_two_qubit_gates,
        }
        for resource, (
            _,
            transpile_ms,
            features_ms,
            _,
            depth_pre,
            depth_post,
            num_two_qubit_gates,
        ) in zip(resources, per_resource_results)
    }
    infeasible_reasons = {
        resource.candidate_id: reason
        for resource, (_, _, _, reason, *_) in zip(resources, per_resource_results)
        if reason is not None
    }

    assembly_start = time.perf_counter()
    normalized_by_resource = compute_normalized_objective_features(raw_features_by_resource)

    # transpile_error resources never make it into the Instance — unlike
    # insufficient_qubits, which the solver can reason about via the
    # num_qubits hard constraint below, a transpile_error means Qiskit
    # couldn't produce a circuit for this resource, so there are no genuine
    # features to build. Still visible via InstanceTimings.infeasible_reasons.
    candidates = [
        Candidate(
            id=resource.candidate_id,
            task_id=TASK_ID,
            provider_id=resource.provider_id,
            name=resource.name,
            features={**raw, **normalized},
        )
        for resource, raw, normalized, (_, _, _, reason, *_) in zip(
            resources, raw_features_by_resource, normalized_by_resource, per_resource_results
        )
        if reason != "transpile_error"
    ]

    if not candidates:
        raise ValueError(
            "No resource could successfully transpile this circuit — every "
            f"candidate failed: {infeasible_reasons}"
        )

    all_feature_specs = [*FEATURE_REGISTRY, *(normalized_feature_spec(fid) for fid in OBJECTIVE_FEATURE_IDS)]
    features_decl = [spec.to_bim_feature() for spec in all_feature_specs]
    # Identity for a single-task workflow: SUM over the one leaf task passes
    # the candidate's feature value straight through.
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
    # num_qubits is the only feasibility constraint QRB imposes
    # automatically. depth_feasible remains a computed Feature (see
    # features.py) and is available as an optional, user-authored Constraint
    # via the Playground's "+ Add constraint" UI for anyone who wants it
    # enforced.
    constraints = [feasibility_constraint, *preferences.to_constraints()]

    instance = Instance(
        metadata=InstanceMetadata(
            id=str(uuid4()),
            name=instance_name,
            version="0.1",
            created_at=datetime.now(timezone.utc),
        ),
        providers=providers,
        tasks=[TaskRef(id=TASK_ID, name="Quantum circuit execution")],
        candidates=candidates,
        features=features_decl,
        composition=StructuredTree(root=TaskNode(id="root", task_id=TASK_ID)),
        aggregation_policies=aggregation_policies,
        constraints=constraints,
        objective=preferences.to_objective(),
    )

    assembly_ms = (time.perf_counter() - assembly_start) * 1000
    timings = InstanceTimings(
        preprocessing_ms=preprocessing_ms,
        transpile_ms=sum(t["transpile_ms"] for t in per_resource_timings.values()),
        features_ms=sum(t["features_ms"] for t in per_resource_timings.values()),
        build_instance_ms=assembly_ms,
        total_ms=(time.perf_counter() - build_start) * 1000,
        per_resource=per_resource_timings,
        infeasible_reasons=infeasible_reasons,
    )
    return instance, timings
