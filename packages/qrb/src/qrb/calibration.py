"""Per-resource calibration summary statistics — median T1/T2 and median
gate/readout error, computed from whichever raw data source actually has
them. IBM's Qiskit Target carries everything; Braket's Target conversion
drops T1/T2/fidelity data, so Braket resources carry a second raw source
(ResourceRecord.raw_calibration, the cross-vendor `standardized`
device-properties object) that this module knows how to read. Two schema
shapes exist within that object — Rigetti/IQM-style (per-qubit
`oneQubitProperties`/per-pair `twoQubitProperties`) and IonQ-style (flat,
device-wide `T1`/`T2`/`twoQubitGateFidelity`/`readoutFidelity`, no per-qubit
breakdown and no 1-qubit gate fidelity at all).

For IonQ, a real 1-qubit fidelity number exists in ResourceRecord.
native_calibration (device.properties.provider, a vendor-native object)
instead, read here as a last-resort fallback.
"""

from __future__ import annotations

import statistics
from dataclasses import dataclass, field

from qrb.providers.base import ResourceRecord

# Excluded from the displayed native gate set (not real gates) — includes
# IBM Target's classical control-flow pseudo-instructions (if_else etc.) and
# duplicate-registered measure/reset variants (measure_2, reset_2, ...).
_CONTROL_FLOW_OPERATIONS = frozenset(
    {"if_else", "for_loop", "while_loop", "switch_case", "break_loop", "continue_loop"}
)


def _is_non_gate_operation(name: str) -> bool:
    return (
        name.startswith("measure")
        or name.startswith("reset")
        or name in ("delay", "barrier")
        or name in _CONTROL_FLOW_OPERATIONS
    )


# Excluded from gate-error stats too, but "measure" (and measure_N variants)
# is handled separately below (it's where IBM's Target reports readout error).
_SKIP_FOR_GATE_ERRORS = frozenset({"delay", "barrier"}) | _CONTROL_FLOW_OPERATIONS

_GATE_FIDELITY_TYPE_NAMES = {"RANDOMIZED_BENCHMARKING", "SIMULTANEOUS_RANDOMIZED_BENCHMARKING"}
_READOUT_FIDELITY_TYPE_NAME = "READOUT"


@dataclass(frozen=True)
class CalibrationSummary:
    native_gates: list[str]
    median_t1_us: float | None
    median_t2_us: float | None
    median_gate_error_1q: float | None
    median_gate_error_2q: float | None
    median_readout_error: float | None
    gate_error_1q_by_qubit: dict[int, float] = field(default_factory=dict)
    gate_error_2q_by_pair: dict[frozenset[int], float] = field(default_factory=dict)
    readout_error_by_qubit: dict[int, float] = field(default_factory=dict)
    """Per-qubit/per-pair error, keyed by physical qubit index (1q/readout)
    or frozenset of the two physical qubit indices (2q) — populated only
    for vendors whose standardized schema reports per-qubit breakdowns
    (Rigetti, IQM). Empty for vendors that only report a flat, device-wide
    number (IonQ) or a partial one (AQT: per-qubit 1q/readout, no per-pair
    2q — see _from_braket). Preferred over the median_* fields by
    qrb.features._lookup_error whenever the specific qubit(s) a gate
    acts on are present here; median_* remains the fallback."""


def calibration_summary(resource: ResourceRecord) -> CalibrationSummary:
    native_gates = sorted(
        name for name in set(resource.target.operation_names) if not _is_non_gate_operation(name)
    )
    stats = (
        _from_braket(resource)
        if resource.raw_calibration is not None
        else _from_ibm_target(resource.target)
    )
    return CalibrationSummary(native_gates=native_gates, **stats)


def _median(values: list[float]) -> float | None:
    clean = [v for v in values if v is not None]
    return statistics.median(clean) if clean else None


def _from_ibm_target(target) -> dict[str, float | None]:
    qubit_properties = target.qubit_properties or []
    t1_values = [qp.t1 * 1e6 for qp in qubit_properties if qp is not None and qp.t1 is not None]
    t2_values = [qp.t2 * 1e6 for qp in qubit_properties if qp is not None and qp.t2 is not None]

    error_1q: list[float] = []
    error_2q: list[float] = []
    readout_errors: list[float] = []
    for name in target.operation_names:
        is_measure = name.startswith("measure")
        if not is_measure and (name.startswith("reset") or name in _SKIP_FOR_GATE_ERRORS):
            continue
        try:
            props_by_qargs = target[name]
        except KeyError:
            continue
        for qargs, props in props_by_qargs.items():
            if props is None or props.error is None:
                continue
            if is_measure:
                readout_errors.append(props.error)
            elif qargs is not None and len(qargs) == 1:
                error_1q.append(props.error)
            elif qargs is not None and len(qargs) == 2:
                error_2q.append(props.error)

    return {
        "median_t1_us": _median(t1_values),
        "median_t2_us": _median(t2_values),
        "median_gate_error_1q": _median(error_1q),
        "median_gate_error_2q": _median(error_2q),
        "median_readout_error": _median(readout_errors),
    }


def _duration_to_us(duration_like) -> float | None:
    """Braket CoherenceTime/Duration objects report `.value` in seconds
    (unit='S') — same convention as Qiskit's qubit_properties."""
    value = getattr(duration_like, "value", None)
    return None if value is None else value * 1e6


def _fidelity_to_error(fidelity_like) -> float | None:
    fidelity = getattr(fidelity_like, "fidelity", None)
    return None if fidelity is None else 1.0 - fidelity


def _fidelity_type_name(fidelity_like) -> str | None:
    fidelity_type = getattr(fidelity_like, "fidelityType", None)
    name = getattr(fidelity_type, "name", None)
    return getattr(name, "value", name)  # unwrap FidelityTypeName enum if present


def _is_gate_fidelity(fidelity_like) -> bool:
    return _fidelity_type_name(fidelity_like) in _GATE_FIDELITY_TYPE_NAMES


def _is_readout_fidelity(fidelity_like) -> bool:
    return _fidelity_type_name(fidelity_like) == _READOUT_FIDELITY_TYPE_NAME


def _from_braket(resource: ResourceRecord) -> dict[str, float | None]:
    """Each metric falls back independently from per-qubit/per-pair data to
    flat device-wide data — devices don't all agree on which schema shape
    they use. IonQ devices (Forte*) have neither oneQubitProperties nor
    twoQubitProperties in the standardized (cross-vendor) schema — only a
    flat twoQubitGateFidelity/readoutFidelity, and no 1-qubit fidelity at
    all. IBEX Q1 is a hybrid: oneQubitProperties is present but only
    carries gate fidelity, not T1/T2 — those still need the flat fallback
    despite per-qubit data existing for other metrics."""
    std = resource.raw_calibration
    one_qubit_properties = getattr(std, "oneQubitProperties", None) or {}
    two_qubit_properties = getattr(std, "twoQubitProperties", None) or {}

    t1_values = [_duration_to_us(getattr(q, "T1", None)) for q in one_qubit_properties.values()]
    t1_values = [v for v in t1_values if v is not None] or [_duration_to_us(getattr(std, "T1", None))]

    t2_values = [_duration_to_us(getattr(q, "T2", None)) for q in one_qubit_properties.values()]
    t2_values = [v for v in t2_values if v is not None] or [_duration_to_us(getattr(std, "T2", None))]

    # No flat fallback for 1-qubit gate error in the standardized (cross-
    # vendor) schema — IonQ doesn't report one at all there. A real number
    # exists in the IonQ-native object instead: resource.native_calibration,
    # device.properties.provider.fidelity == {"1Q": {"mean": ...}, ...}.
    gate_error_1q_by_qubit: dict[int, float] = {}
    readout_error_by_qubit: dict[int, float] = {}
    for qubit_str, q in one_qubit_properties.items():
        fidelities = getattr(q, "oneQubitFidelity", None) or []
        gate_errors = [_fidelity_to_error(f) for f in fidelities if _is_gate_fidelity(f)]
        median_gate_error = _median(gate_errors)
        if median_gate_error is not None:
            gate_error_1q_by_qubit[int(qubit_str)] = median_gate_error
        readout_errors_here = [_fidelity_to_error(f) for f in fidelities if _is_readout_fidelity(f)]
        median_readout = _median(readout_errors_here)
        if median_readout is not None:
            readout_error_by_qubit[int(qubit_str)] = median_readout

    error_1q = list(gate_error_1q_by_qubit.values())
    if not error_1q and resource.vendor == "IonQ" and resource.native_calibration is not None:
        mean_1q_fidelity = resource.native_calibration.fidelity.get("1Q", {}).get("mean")
        if mean_1q_fidelity is not None:
            error_1q = [1.0 - mean_1q_fidelity]

    readout_errors = list(readout_error_by_qubit.values())
    if not readout_errors:
        readout_errors = [
            _fidelity_to_error(f) for f in getattr(std, "readoutFidelity", None) or []
        ]

    gate_error_2q_by_pair: dict[frozenset[int], float] = {}
    for pair_str, pair_props in two_qubit_properties.items():
        pair = frozenset(int(q) for q in pair_str.split("-"))
        errors = [_fidelity_to_error(f) for f in getattr(pair_props, "twoQubitGateFidelity", None) or []]
        median_error = _median(errors)
        if median_error is not None:
            gate_error_2q_by_pair[pair] = median_error

    error_2q = list(gate_error_2q_by_pair.values())
    if not error_2q:
        error_2q = [
            _fidelity_to_error(f) for f in getattr(std, "twoQubitGateFidelity", None) or []
        ]

    return {
        "median_t1_us": _median(t1_values),
        "median_t2_us": _median(t2_values),
        "median_gate_error_1q": _median(error_1q),
        "median_gate_error_2q": _median(error_2q),
        "median_readout_error": _median(readout_errors),
        "gate_error_1q_by_qubit": gate_error_1q_by_qubit,
        "gate_error_2q_by_pair": gate_error_2q_by_pair,
        "readout_error_by_qubit": readout_error_by_qubit,
    }
