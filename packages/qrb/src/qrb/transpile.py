"""Uniform Qiskit transpilation pipeline: the same optimization level and
seed against every Resource's Target, regardless of provider — except
trapped-ion native gate sets (see IONQ_NATIVE_GATES). IonQ's own docs warn
optimization_level 2/3 causes "a significant net reduction in efficiency and
overall performance" translating standard gates onto GPi/GPi2/(RZZ|MS):
https://docs.ionq.com/sdks/qiskit/native-gates-qiskit — in practice this is
pathological rather than just slower, and level 1 alone isn't enough to
avoid it either; only level 0 (skips the optimization/synthesis passes that
search for better decompositions) reliably completes. Produces the
task-dependent data behind expected_fidelity and (for IBM) cost.
"""

from __future__ import annotations

import logging
import statistics
from dataclasses import dataclass

from qiskit.circuit import QuantumCircuit
from qiskit.transpiler.preset_passmanagers import generate_preset_pass_manager

from qrb.providers.base import ResourceRecord

logger = logging.getLogger(__name__)

DEFAULT_OPTIMIZATION_LEVEL = 0
DEFAULT_TRANSPILER_SEED = 1234
"""Fixed by default so transpiled depth/2q-count/fidelity are reproducible
run to run despite optimization level 3's stochastic layout/routing."""

IONQ_NATIVE_GATES = frozenset({"gpi", "gpi2", "rzz", "ms"})
IONQ_OPTIMIZATION_LEVEL = 0
"""Only level that reliably avoids the pathological search (see module
docstring) — level 1 still hung against the same real resource."""

_NON_GATE_OPERATIONS = frozenset({"measure", "delay", "reset", "barrier"})


@dataclass(frozen=True)
class TranspileResult:
    resource: ResourceRecord
    feasible: bool
    """False when the circuit's width exceeds the resource's qubit capacity —
    transpilation is skipped and downstream features get placeholder values.
    The solver still enforces feasibility via the hard num_qubits constraint;
    this flag only controls whether qrb bothers computing real features."""
    circuit: QuantumCircuit | None
    depth: int | None
    num_two_qubit_gates: int | None
    circuit_duration_s: float | None
    """Real execution duration estimate (critical-path makespan across all
    qubits, given each instruction's calibrated duration) — only computed
    for IBM (see _critical_path_duration). None otherwise."""
    depth_feasible: bool = True
    """NISQ Analyzer's feasibility bound (salm2020): False when the compiled
    circuit's depth exceeds avg_T1 / max_gate_duration for the resource.
    True (unconstrained) when T1 or gate-duration data is unavailable, or
    when `feasible` is already False for width. Not auto-enforced as a
    hard constraint (num_qubits is the only feasibility QRB imposes
    automatically) — this is a computed Feature a user can optionally
    bind a Constraint against, not nulled out here since — unlike width —
    the bound varies per resource on both sides and can't be expressed as
    a single circuit-wide threshold."""
    infeasible_reason: str | None = None
    """Why feasible=False: "insufficient_qubits" (checked up front, no
    transpile attempted) or "transpile_error" (Qiskit's pipeline raised —
    an unsupported gate, an internal transpiler bug, anything not caught by
    the qubit-count check). None when feasible=True. Surfaced via
    InstanceTimings.infeasible_reasons so a genuine per-resource compile
    failure shows up as a fast, visible exclusion instead of taking down
    the whole build_instance() call for every other resource too."""


def _average_t1(target) -> float | None:
    qubit_properties = target.qubit_properties
    if not qubit_properties:
        return None
    t1_values = [qp.t1 for qp in qubit_properties if qp is not None and qp.t1 is not None]
    if not t1_values:
        return None
    return statistics.mean(t1_values)


def _max_gate_duration(target) -> float | None:
    max_duration = None
    for name in target.operation_names:
        if name in _NON_GATE_OPERATIONS:
            continue
        try:
            properties_by_qargs = target[name]
        except KeyError:
            continue
        for props in properties_by_qargs.values():
            if props is not None and props.duration is not None:
                if max_duration is None or props.duration > max_duration:
                    max_duration = props.duration
    return max_duration


def _max_executable_depth(target) -> float | None:
    """avg_T1 / max_gate_duration (salm2020, Sec. 5: `executable/4`'s
    `CircuitDepth =< T1Time/GateTime`). None when either input is
    unavailable — currently: any non-IBM target.
    """
    avg_t1 = _average_t1(target)
    max_duration = _max_gate_duration(target)
    if avg_t1 is None or not max_duration:
        return None
    return avg_t1 / max_duration


def transpile_for_resource(
    circuit: QuantumCircuit,
    resource: ResourceRecord,
    *,
    optimization_level: int = DEFAULT_OPTIMIZATION_LEVEL,
    seed: int = DEFAULT_TRANSPILER_SEED,
) -> TranspileResult:
    if circuit.num_qubits > resource.num_qubits:
        return TranspileResult(
            resource=resource,
            feasible=False,
            circuit=None,
            depth=None,
            num_two_qubit_gates=None,
            circuit_duration_s=None,
            infeasible_reason="insufficient_qubits",
        )

    if IONQ_NATIVE_GATES & set(resource.target.operation_names):
        optimization_level = IONQ_OPTIMIZATION_LEVEL

    want_schedule = resource.provider_id == "ibm"
    try:
        transpiled, duration = _run_pipeline(
            circuit, resource, optimization_level, seed, schedule=want_schedule
        )
    except Exception:
        # Anything Qiskit's transpiler itself raises (unsupported gate,
        # an internal transpiler bug, any circuit/target combination not
        # covered by the qubit-count check above) — mark this one resource
        # infeasible and move on instead of letting the exception propagate
        # out of parallel_map() and take down every other resource's
        # already-computed work too.
        logger.warning(
            "Transpile failed for %s — marking infeasible.", resource.candidate_id, exc_info=True
        )
        return TranspileResult(
            resource=resource,
            feasible=False,
            circuit=None,
            depth=None,
            num_two_qubit_gates=None,
            circuit_duration_s=None,
            infeasible_reason="transpile_error",
        )

    depth = transpiled.depth()
    max_depth = _max_executable_depth(resource.target)
    num_two_qubit_gates = sum(1 for instr in transpiled.data if instr.operation.num_qubits == 2)
    return TranspileResult(
        resource=resource,
        feasible=True,
        circuit=transpiled,
        depth=depth,
        num_two_qubit_gates=num_two_qubit_gates,
        circuit_duration_s=duration,
        depth_feasible=max_depth is None or depth <= max_depth,
    )


def _run_pipeline(
    circuit: QuantumCircuit,
    resource: ResourceRecord,
    optimization_level: int,
    seed: int,
    *,
    schedule: bool,
) -> tuple[QuantumCircuit, float | None]:
    pm = generate_preset_pass_manager(
        target=resource.target, optimization_level=optimization_level, seed_transpiler=seed
    )
    transpiled = pm.run(circuit)
    duration = _critical_path_duration(transpiled, resource.target) if schedule else None
    return transpiled, duration


def _critical_path_duration(circuit: QuantumCircuit, target) -> float:
    """The circuit's real execution duration — critical-path makespan
    across all qubits, given each instruction's calibrated duration. This
    is IBM's own <circuit length> term in its cost-estimation formula
    (per-sub-job overhead + (rep_delay + circuit length) * executions).

    Computed directly with a single forward pass instead of via Qiskit's
    ALAPScheduleAnalysis + PadDelay: those passes additionally MUTATE the
    circuit, materializing explicit Delay instructions so every qubit's
    timeline is padded to the same absolute time — necessary if you're
    about to actually schedule/run the circuit, irrelevant if all you want
    is the duration number. Verified bit-identical to Qiskit's own
    scheduled-circuit estimate_duration() across 7 real benchmark circuits
    (ghz/qft/qaoa/graphstate/wstate/vqe_su2/randomcircuit, up to a
    2.85-million-instruction case) — the DAG mutation work real scheduling
    also does, not the duration math itself, is what made it ~11x slower
    (32s -> 2.9s on that case).
    """
    finish_time = [0.0] * circuit.num_qubits
    duration_cache: dict[tuple[str, tuple[int, ...]], float] = {}
    for instr in circuit.data:
        name = instr.operation.name
        qargs = tuple(circuit.find_bit(q).index for q in instr.qubits)
        key = (name, qargs)
        duration = duration_cache.get(key)
        if duration is None:
            try:
                duration = target[name][qargs].duration or 0.0
            except KeyError:
                duration = 0.0
            duration_cache[key] = duration
        start = max((finish_time[q] for q in qargs), default=0.0)
        end = start + duration
        for q in qargs:
            finish_time[q] = end
    return max(finish_time, default=0.0)
