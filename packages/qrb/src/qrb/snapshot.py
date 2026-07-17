"""Recorded catalog snapshots: a serialized Resource catalog for reproducible,
creds-free runs (--snapshot). Live fetch is the default; a snapshot captures
raw calibration data and rebuilds a working Qiskit Target from it, so
transpilation still runs per-circuit exactly as in live mode.

Gate coverage is intentionally limited to common IBM/Braket native gates
(see GATE_FACTORY). An unsupported gate name fails loudly — better than
silently producing a Target with wrong physics.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from braket.schema_common.schema_base import BraketSchemaBase
from pydantic import BaseModel
from qiskit.circuit import Delay, Measure, Parameter, Reset
from qiskit.circuit.library import (
    CXGate,
    CZGate,
    ECRGate,
    HGate,
    IGate,
    RGate,
    RXGate,
    RXXGate,
    RYGate,
    RZGate,
    RZZGate,
    SdgGate,
    SGate,
    SwapGate,
    SXdgGate,
    SXGate,
    TdgGate,
    TGate,
    UGate,
    XGate,
    YGate,
    ZGate,
    iSwapGate,
)
from qiskit.transpiler import InstructionProperties, Target
from qiskit_ionq.ionq_gates import GPI2Gate, GPIGate

from qrb.calibration import _is_non_gate_operation
from qrb.providers.base import BraketPricing, IBMPricing, Pricing, ResourceRecord

DEFAULT_SNAPSHOT_PATH = Path("catalog_snapshot.json")

_THETA = Parameter("theta")
_PHI = Parameter("phi")
_LAM = Parameter("lambda")

GATE_FACTORY = {
    "id": lambda: IGate(),
    "x": lambda: XGate(),
    "y": lambda: YGate(),
    "z": lambda: ZGate(),
    "h": lambda: HGate(),
    "s": lambda: SGate(),
    "sdg": lambda: SdgGate(),
    "t": lambda: TGate(),
    "tdg": lambda: TdgGate(),
    "sx": lambda: SXGate(),
    "sxdg": lambda: SXdgGate(),
    "rz": lambda: RZGate(_LAM),
    "rx": lambda: RXGate(_THETA),
    "ry": lambda: RYGate(_THETA),
    "r": lambda: RGate(_THETA, _PHI),
    "u": lambda: UGate(_THETA, _PHI, _LAM),
    "cx": lambda: CXGate(),
    "cz": lambda: CZGate(),
    "ecr": lambda: ECRGate(),
    "swap": lambda: SwapGate(),
    "iswap": lambda: iSwapGate(),
    "rxx": lambda: RXXGate(_THETA),
    "rzz": lambda: RZZGate(_THETA),
    # IonQ trapped-ion native gates (see qrb.transpile.IONQ_NATIVE_GATES).
    "gpi": lambda: GPIGate(_PHI),
    "gpi2": lambda: GPI2Gate(_PHI),
}


class UnsupportedGateError(ValueError):
    pass


class InstructionSnapshot(BaseModel):
    name: str
    qargs: tuple[int, ...]
    duration: float | None = None
    error: float | None = None


class ResourceSnapshot(BaseModel):
    resource_id: str
    provider_id: str
    vendor: str
    name: str
    num_qubits: int
    dt: float | None = None
    queue_length: int | None = None
    pricing: dict
    instructions: list[InstructionSnapshot]
    status: str = "unknown"
    operational: bool = True
    """Defaults keep old snapshot files (recorded before these fields
    existed) loadable without failing a require_operational constraint."""
    last_calibrated_at: datetime | None = None
    raw_calibration_json: str | None = None
    """Serialized braket.device_schema.standardized...StandardizedGateModel-
    QpuDeviceProperties (via its own .json(), a pydantic v1 model bundled
    inside the braket SDK) — None for IBM, where Target already carries
    everything. Restored via BraketSchemaBase.parse_raw_schema(), which
    picks the right versioned schema class from the embedded header. Needed
    for qrb.features._expected_fidelity's fallback to qrb.calibration
    for vendors whose Target has no real per-gate error data (IonQ's
    Forte*, AQT's IBEX Q1 — see calibration.py); without it those resources
    would round-trip through a snapshot with a spurious expected_fidelity
    of 1.0. Default None keeps old snapshot files loadable."""
    native_calibration_json: str | None = None
    """Serialized device.properties.provider (a vendor-native object, a
    different schema from raw_calibration_json's cross-vendor standardized
    one — also a BraketSchemaBase/pydantic-v1 model, same .json()/
    parse_raw_schema() round-trip) — e.g. IonqProviderProperties,
    RigettiProviderProperties. Only consulted by qrb.calibration as a
    last-resort fallback for values the standardized schema leaves
    unpopulated for a given vendor. None for IBM."""


def _pricing_to_dict(pricing: Pricing) -> dict:
    if isinstance(pricing, IBMPricing):
        return {"kind": "ibm", "rate_usd_per_second": pricing.rate_usd_per_second}
    if isinstance(pricing, BraketPricing):
        return {
            "kind": "braket",
            "per_task_usd": pricing.per_task_usd,
            "per_shot_usd": pricing.per_shot_usd,
        }
    raise TypeError(f"Unknown pricing model: {pricing!r}")


def _pricing_from_dict(data: dict) -> Pricing:
    if data["kind"] == "ibm":
        return IBMPricing(rate_usd_per_second=data["rate_usd_per_second"])
    if data["kind"] == "braket":
        return BraketPricing(per_task_usd=data["per_task_usd"], per_shot_usd=data["per_shot_usd"])
    raise ValueError(f"Unknown pricing kind: {data['kind']!r}")


def resource_to_snapshot(resource: ResourceRecord) -> ResourceSnapshot:
    target = resource.target
    instructions = []
    for name in target.operation_names:
        for qargs, props in target[name].items():
            if qargs is None:
                continue
            instructions.append(
                InstructionSnapshot(
                    name=name,
                    qargs=tuple(qargs),
                    duration=props.duration if props else None,
                    error=props.error if props else None,
                )
            )
    return ResourceSnapshot(
        resource_id=resource.resource_id,
        provider_id=resource.provider_id,
        vendor=resource.vendor,
        name=resource.name,
        num_qubits=resource.num_qubits,
        dt=target.dt,
        queue_length=resource.queue_length,
        pricing=_pricing_to_dict(resource.pricing),
        instructions=instructions,
        status=resource.status,
        operational=resource.operational,
        last_calibrated_at=resource.last_calibrated_at,
        raw_calibration_json=resource.raw_calibration.json() if resource.raw_calibration is not None else None,
        native_calibration_json=resource.native_calibration.json()
        if resource.native_calibration is not None
        else None,
    )


_FEED_FORWARD_OPERATIONS = frozenset({"CCPRx", "MeasureFF"})
"""Rigetti mid-circuit-measurement/feedback instructions (real-time
classical control, not a gate applied during normal synthesis/routing) —
deliberately skipped rather than reconstructed, same reasoning as
_is_non_gate_operation's control-flow exclusions, just named separately
since these aren't Qiskit control-flow ops."""


def snapshot_to_resource(snapshot: ResourceSnapshot) -> ResourceRecord:
    target = Target(num_qubits=snapshot.num_qubits, dt=snapshot.dt)
    by_name: dict[str, dict[tuple[int, ...], InstructionProperties]] = {}
    for instr in snapshot.instructions:
        by_name.setdefault(instr.name, {})[instr.qargs] = InstructionProperties(
            duration=instr.duration, error=instr.error
        )

    for name, qarg_props in by_name.items():
        if name == "measure":
            target.add_instruction(Measure(), qarg_props)
        elif name == "reset":
            target.add_instruction(Reset(), qarg_props)
        elif name == "delay":
            target.add_instruction(Delay(Parameter("t")), qarg_props)
        elif name in GATE_FACTORY:
            target.add_instruction(GATE_FACTORY[name](), qarg_props)
        elif _is_non_gate_operation(name) or name in _FEED_FORWARD_OPERATIONS:
            # measure_2/reset_2 (duplicate-registered variants) and
            # Qiskit's own control-flow pseudo-ops, plus the feed-forward
            # exclusions above — none of these affect transpilation
            # (routing/synthesis never target them), so the snapshot just
            # doesn't carry them instead of needing a real Gate class.
            continue
        else:
            raise UnsupportedGateError(
                f"No gate factory registered for '{name}' — add it to "
                f"qrb.snapshot.GATE_FACTORY to support this resource."
            )

    raw_calibration = (
        BraketSchemaBase.parse_raw_schema(snapshot.raw_calibration_json)
        if snapshot.raw_calibration_json is not None
        else None
    )
    native_calibration = (
        BraketSchemaBase.parse_raw_schema(snapshot.native_calibration_json)
        if snapshot.native_calibration_json is not None
        else None
    )
    return ResourceRecord(
        resource_id=snapshot.resource_id,
        provider_id=snapshot.provider_id,
        vendor=snapshot.vendor,
        name=snapshot.name,
        num_qubits=snapshot.num_qubits,
        target=target,
        queue_length=snapshot.queue_length,
        pricing=_pricing_from_dict(snapshot.pricing),
        status=snapshot.status,
        operational=snapshot.operational,
        last_calibrated_at=snapshot.last_calibrated_at,
        raw_calibration=raw_calibration,
        native_calibration=native_calibration,
    )


class CatalogSnapshot(BaseModel):
    """The on-disk shape: when the whole catalog was captured, plus one
    ResourceSnapshot per resource. captured_at is the wall-clock fetch time
    (UTC) — the "one complete live fetch... captured on [date/time UTC]"
    a frozen-snapshot experiment needs to cite, and distinct from each
    resource's own last_calibrated_at (the provider's calibration
    timestamp, not qrb's fetch time)."""

    captured_at: datetime
    resources: list[ResourceSnapshot]


def save_snapshot(resources: list[ResourceRecord], path: Path = DEFAULT_SNAPSHOT_PATH) -> None:
    snapshot = CatalogSnapshot(
        captured_at=datetime.now(timezone.utc),
        resources=[resource_to_snapshot(r) for r in resources],
    )
    path.write_text(snapshot.model_dump_json(indent=2))


def snapshot_captured_at(path: Path = DEFAULT_SNAPSHOT_PATH) -> datetime | None:
    """None for a pre-existing snapshot file recorded before this field
    existed (a bare JSON array, see load_snapshot's backward-compat path)."""
    data = json.loads(path.read_text())
    if isinstance(data, list):
        return None
    return CatalogSnapshot.model_validate(data).captured_at


def load_snapshot(path: Path = DEFAULT_SNAPSHOT_PATH) -> list[ResourceRecord]:
    data = json.loads(path.read_text())
    # Backward compat: a snapshot file recorded before CatalogSnapshot
    # existed is a bare JSON array of ResourceSnapshot, not the wrapper —
    # still loadable, it just has no known captured_at (see above).
    resource_dicts = data if isinstance(data, list) else data["resources"]
    return [snapshot_to_resource(ResourceSnapshot.model_validate(s)) for s in resource_dicts]
