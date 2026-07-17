"""The QoS feature registry (F). Each Feature is declarative — id, direction,
unit, scale, valid_range — with an extractor that computes its value for one
Candidate from a ResourceRecord + TranspileResult. Adding a feature means
adding one FeatureSpec; the BIM `features` array and each candidate's
`features` map are generated from this registry.
"""

from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone

from openbinding import Direction, Feature, NumericRange, Scale
from qiskit.converters import circuit_to_dag

from qrb.calibration import CalibrationSummary, calibration_summary
from qrb.pricing import IBM_PER_SUBJOB_OVERHEAD_S, IBM_QUICK_FORMULA_SLOPE
from qrb.providers.base import BraketPricing, IBMPricing, ResourceRecord
from qrb.transpile import TranspileResult

Extractor = Callable[[ResourceRecord, TranspileResult, int], float]


@dataclass(frozen=True)
class FeatureSpec:
    id: str
    name: str
    direction: Direction
    unit: str
    scale: Scale
    valid_range: NumericRange
    extractor: Extractor

    def to_bim_feature(self) -> Feature:
        return Feature(
            id=self.id,
            name=self.name,
            direction=self.direction,
            unit=self.unit,
            scale=self.scale,
            valid_range=self.valid_range,
        )


def _expected_fidelity(resource: ResourceRecord, tr: TranspileResult, shots: int) -> float:
    """Estimated Success Probability: ∏ F(g_i) · ∏ F_RO(q_j) over the compiled
    circuit — the product of per-gate execution fidelities and per-qubit
    readout fidelities. 0 for resources too small for the circuit.

    Falls back to calibration_summary()'s raw_calibration-derived median
    error rates when the Target itself has no per-gate error data at all —
    qiskit_braket_provider drops calibration entirely for some vendors
    (IonQ's Forte*, AQT's IBEX Q1), which without this fallback would treat
    every gate as perfect (error=0.0), scoring those resources a spurious
    expected_fidelity of 1.0 despite real calibration data being available
    in raw_calibration.
    """
    if not tr.feasible or tr.circuit is None:
        return 0.0

    target = resource.target
    fallback = None if _target_has_error_data(target) else calibration_summary(resource)
    fidelity = 1.0
    for instruction in tr.circuit.data:
        op = instruction.operation
        if op.name in ("barrier", "delay", "reset"):
            continue
        qargs = tuple(tr.circuit.find_bit(q).index for q in instruction.qubits)
        error = _lookup_error(target, op.name, qargs, fallback)
        fidelity *= 1.0 - error
    return fidelity


def _target_has_error_data(target) -> bool:
    for name in target.operation_names:
        try:
            props_by_qargs = target[name]
        except KeyError:
            continue
        for props in props_by_qargs.values():
            if props is not None and props.error is not None:
                return True
    return False


def _lookup_error(
    target, name: str, qargs: tuple[int, ...], fallback: CalibrationSummary | None
) -> float:
    if name in target.operation_names:
        props = target[name].get(qargs)
        if props is not None and props.error is not None:
            return props.error
    if fallback is None:
        return 0.0
    # Real per-qubit/per-pair data (Rigetti, IQM — see CalibrationSummary)
    # takes priority over the device-wide median whenever the specific
    # qubit(s) this instruction acts on are covered by it; only whatever
    # isn't covered (or a vendor that never reports per-qubit granularity,
    # e.g. IonQ) falls through to the median.
    if name.startswith("measure"):
        per_qubit = fallback.readout_error_by_qubit.get(qargs[0])
        return per_qubit if per_qubit is not None else (fallback.median_readout_error or 0.0)
    if len(qargs) == 1:
        per_qubit = fallback.gate_error_1q_by_qubit.get(qargs[0])
        return per_qubit if per_qubit is not None else (fallback.median_gate_error_1q or 0.0)
    if len(qargs) == 2:
        per_pair = fallback.gate_error_2q_by_pair.get(frozenset(qargs))
        return per_pair if per_pair is not None else (fallback.median_gate_error_2q or 0.0)
    return 0.0


def _cost(resource: ResourceRecord, tr: TranspileResult, shots: int) -> float:
    if isinstance(resource.pricing, IBMPricing):
        return _ibm_cost(resource.pricing, tr, shots)
    if isinstance(resource.pricing, BraketPricing):
        return resource.pricing.per_task_usd + resource.pricing.per_shot_usd * shots
    raise TypeError(f"Unknown pricing model: {resource.pricing!r}")


def _ibm_cost(pricing: IBMPricing, tr: TranspileResult, shots: int) -> float:
    if tr.circuit_duration_s is not None:
        total_time_s = IBM_PER_SUBJOB_OVERHEAD_S + tr.circuit_duration_s * shots
    else:
        total_time_s = IBM_PER_SUBJOB_OVERHEAD_S + IBM_QUICK_FORMULA_SLOPE * shots
    return pricing.rate_usd_per_second * total_time_s


def _queue(resource: ResourceRecord, tr: TranspileResult, shots: int) -> float:
    return float(resource.queue_length) if resource.queue_length is not None else 0.0


def _critical_depth(resource: ResourceRecord, tr: TranspileResult, shots: int) -> float:
    """Ratio of 2-qubit gates on the compiled circuit's critical path to the
    total number of 2-qubit gates (SupermarQ's metric, as used by MQT
    Predictor's `crit_depth` reward). 0 == fully parallel, 1 == fully
    sequential; 1.0 (worst) for infeasible resources, matching
    _expected_fidelity's worst-case convention.
    """
    if not tr.feasible or tr.circuit is None:
        return 1.0
    dag = circuit_to_dag(tr.circuit)
    two_qubit_ops = dag.two_qubit_ops()
    n_e = len(two_qubit_ops)
    if n_e == 0:
        return 0.0
    two_qubit_names = {op.name for op in two_qubit_ops}
    longest_path_ops = dag.count_ops_longest_path()
    n_ed = sum(longest_path_ops.get(name, 0) for name in two_qubit_names)
    return n_ed / n_e


def _estimated_success_probability(resource: ResourceRecord, tr: TranspileResult, shots: int) -> float:
    """Expected fidelity discounted by T1/T2 decoherence during idle
    (Delay) time, mirroring MQT Predictor's `estimated_success_probability`.
    Reuses the ALAP-scheduled circuit already computed for IBM cost
    purposes — total per-qubit idle time is schedule-policy-independent
    (ALAP vs. ASAP only reposition delays within a fixed makespan), so no
    second scheduling pass is needed. Degrades to plain expected_fidelity
    when no Delay instructions or no T1/T2 data are present (unscheduled
    circuits — currently all non-IBM resources).
    """
    fidelity = _expected_fidelity(resource, tr, shots)
    if not tr.feasible or tr.circuit is None:
        return fidelity

    qubit_properties = resource.target.qubit_properties
    dt = resource.target.dt
    if not qubit_properties or dt is None:
        return fidelity

    circuit = tr.circuit
    used_qubits = {
        circuit.find_bit(q).index
        for instruction in circuit.data
        if instruction.operation.name not in ("barrier", "delay", "reset")
        for q in instruction.qubits
    }
    idle_seconds_by_qubit: dict[int, float] = {}
    for instruction in circuit.data:
        if instruction.operation.name != "delay":
            continue
        (qubit,) = instruction.qubits
        idx = circuit.find_bit(qubit).index
        if idx not in used_qubits:
            continue
        duration = instruction.operation.duration or 0
        idle_seconds_by_qubit[idx] = idle_seconds_by_qubit.get(idx, 0.0) + duration * dt

    decay = 1.0
    for idx, idle_s in idle_seconds_by_qubit.items():
        if idx >= len(qubit_properties):
            continue
        props = qubit_properties[idx]
        if props is None or props.t1 is None or props.t2 is None:
            continue
        decay *= math.exp(-idle_s / min(props.t1, props.t2))
    return fidelity * decay


def _num_qubits(resource: ResourceRecord, tr: TranspileResult, shots: int) -> float:
    return float(resource.num_qubits)


def _operational(resource: ResourceRecord, tr: TranspileResult, shots: int) -> float:
    return 1.0 if resource.operational else 0.0


def _depth_feasible(resource: ResourceRecord, tr: TranspileResult, shots: int) -> float:
    return 1.0 if tr.depth_feasible else 0.0


UNKNOWN_CALIBRATION_AGE_HOURS = 1.0e6
"""Sentinel for a missing last_calibrated_at — treated as arbitrarily stale
so a max_calibration_age_hours constraint excludes it, rather than silently
passing a resource we have no calibration data for."""


def _calibration_age_hours(resource: ResourceRecord, tr: TranspileResult, shots: int) -> float:
    if resource.last_calibrated_at is None:
        return UNKNOWN_CALIBRATION_AGE_HOURS
    age = datetime.now(timezone.utc) - resource.last_calibrated_at
    return age.total_seconds() / 3600.0


FEATURE_REGISTRY: list[FeatureSpec] = [
    FeatureSpec(
        id="expected_fidelity",
        name="Expected Fidelity",
        direction=Direction.MAXIMIZE,
        unit="probability",
        scale=Scale.RATIO,
        valid_range=NumericRange(min=0.0, max=1.0),
        extractor=_expected_fidelity,
    ),
    FeatureSpec(
        id="cost",
        name="Estimated Cost",
        direction=Direction.MINIMIZE,
        unit="usd",
        scale=Scale.RATIO,
        valid_range=NumericRange(min=0.0, max=1000.0),
        extractor=_cost,
    ),
    FeatureSpec(
        id="queue",
        name="Queue Length",
        direction=Direction.MINIMIZE,
        unit="pending_jobs",
        scale=Scale.RATIO,
        valid_range=NumericRange(min=0.0, max=10000.0),
        extractor=_queue,
    ),
    FeatureSpec(
        id="critical_depth",
        name="Critical Depth",
        direction=Direction.MINIMIZE,
        unit="ratio",
        scale=Scale.RATIO,
        valid_range=NumericRange(min=0.0, max=1.0),
        extractor=_critical_depth,
    ),
    FeatureSpec(
        id="estimated_success_probability",
        name="Estimated Success Probability",
        direction=Direction.MAXIMIZE,
        unit="probability",
        scale=Scale.RATIO,
        valid_range=NumericRange(min=0.0, max=1.0),
        extractor=_estimated_success_probability,
    ),
    FeatureSpec(
        id="num_qubits",
        name="Number of Qubits",
        direction=Direction.MAXIMIZE,
        unit="count",
        scale=Scale.RATIO,
        valid_range=NumericRange(min=0.0, max=10000.0),
        extractor=_num_qubits,
    ),
    FeatureSpec(
        id="operational",
        name="Operational",
        direction=Direction.MAXIMIZE,
        unit="boolean",
        scale=Scale.RATIO,
        valid_range=NumericRange(min=0.0, max=1.0),
        extractor=_operational,
    ),
    FeatureSpec(
        id="depth_feasible",
        name="Depth Feasible",
        direction=Direction.MAXIMIZE,
        unit="boolean",
        scale=Scale.RATIO,
        valid_range=NumericRange(min=0.0, max=1.0),
        extractor=_depth_feasible,
    ),
    FeatureSpec(
        id="calibration_age_hours",
        name="Calibration Age",
        direction=Direction.MINIMIZE,
        unit="hours",
        scale=Scale.RATIO,
        valid_range=NumericRange(min=0.0, max=UNKNOWN_CALIBRATION_AGE_HOURS),
        extractor=_calibration_age_hours,
    ),
]
"""num_qubits, operational, depth_feasible, and calibration_age_hours are
present but never weighted in an Objective (excluded from
OBJECTIVE_FEATURE_IDS) — hard constraints (feasibility, require_operational,
max_calibration_age_hours) are the only thing that reads them.
AttributeBoundConstraint(hard=False) is rejected outright by minizinc-csp's
request schema, so there is no working soft-constraint mechanism to offer
here."""

OBJECTIVE_FEATURE_IDS = (
    "expected_fidelity",
    "cost",
    "queue",
    "critical_depth",
    "estimated_success_probability",
)
"""The features a Preferences.weights dict may reference."""

_FEATURE_BY_ID = {spec.id: spec for spec in FEATURE_REGISTRY}


def compute_candidate_features(
    resource: ResourceRecord, tr: TranspileResult, shots: int
) -> dict[str, float]:
    return {spec.id: spec.extractor(resource, tr, shots) for spec in FEATURE_REGISTRY}


def normalized_feature_id(feature_id: str) -> str:
    """The BIM feature id used in the Objective for one of OBJECTIVE_FEATURE_IDS.

    OpenBinding's own engines implement per-feature min-max normalization
    (aggregation.py's normalize_qos/_normalize_minmax) but the field that
    would request it isn't wired into the validated request schema on any
    branch yet, and minizinc-csp (our default EXACT engine) never applies it
    even when present — its own MiniZinc model computes a raw weighted sum.
    So qrb normalizes client-side and sends the *_normalized companion as
    the objective target, leaving the raw feature untouched for constraints
    (a `max_cost` constraint means real dollars, not a normalized score).
    """
    return f"{feature_id}_normalized"


def normalized_feature_spec(feature_id: str) -> FeatureSpec:
    raw = _FEATURE_BY_ID[feature_id]
    return FeatureSpec(
        id=normalized_feature_id(feature_id),
        name=f"{raw.name} (normalized)",
        direction=Direction.MAXIMIZE,
        unit="normalized_score",
        scale=Scale.RATIO,
        valid_range=NumericRange(min=0.0, max=1.0),
        extractor=raw.extractor,  # unused: normalized values are computed separately
    )


def compute_normalized_objective_features(
    raw_features_by_candidate: list[dict[str, float]],
) -> list[dict[str, float]]:
    """Per-request min-max normalization of OBJECTIVE_FEATURE_IDS across the
    candidate set actually present in this request, direction-aware (higher
    is always better after normalization). Mirrors aggregation.py's
    _normalize_minmax exactly: mx == mn ties are mapped to 0.0.
    """
    bounds = {}
    for feature_id in OBJECTIVE_FEATURE_IDS:
        values = [raw[feature_id] for raw in raw_features_by_candidate]
        bounds[feature_id] = (min(values), max(values))

    normalized_list = []
    for raw in raw_features_by_candidate:
        normalized = {}
        for feature_id in OBJECTIVE_FEATURE_IDS:
            mn, mx = bounds[feature_id]
            if mx == mn:
                value = 0.0
            else:
                value = (raw[feature_id] - mn) / (mx - mn)
                value = min(1.0, max(0.0, value))
                if _FEATURE_BY_ID[feature_id].direction == Direction.MINIMIZE:
                    value = 1.0 - value
            normalized[normalized_feature_id(feature_id)] = value
        normalized_list.append(normalized)
    return normalized_list
