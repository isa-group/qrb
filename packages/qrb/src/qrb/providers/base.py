"""Resource: hardware identity (topology, native gates, calibration). A
Resource is not a Candidate — the same Resource may be offered by several
Providers (ADR 0001), each producing a distinct Candidate.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Protocol

from qiskit.transpiler import Target

_DISALLOWED = re.compile(r"[^A-Za-z0-9_.-]+")


def sanitize_identifier(raw: str) -> str:
    """BIM identifiers must match ^[A-Za-z0-9_.-]+$ — device names (e.g.
    Braket's 'Aria 1') can contain spaces or other characters that don't."""
    return _DISALLOWED.sub("_", raw)


@dataclass(frozen=True)
class IBMPricing:
    """Pay-As-You-Go: billed per second of QPU execution time."""

    rate_usd_per_second: float


@dataclass(frozen=True)
class BraketPricing:
    """Per-task + per-shot pricing, as published by AWS Braket."""

    per_task_usd: float
    per_shot_usd: float


Pricing = IBMPricing | BraketPricing


@dataclass(frozen=True)
class ResourceRecord:
    """Hardware identity + capability/calibration data for one quantum
    resource, as offered by one Provider (access platform).
    """

    resource_id: str
    provider_id: str
    """Access platform: 'ibm' | 'braket'."""
    vendor: str
    """Hardware vendor, e.g. 'IBM', 'IonQ', 'Rigetti', 'IQM', 'QuEra', 'AQT'."""
    name: str
    num_qubits: int
    target: Target
    """Qiskit Target — native gates, coupling map, calibration. Used uniformly
    for transpilation and for the expected_fidelity feature extractor."""
    queue_length: int | None
    pricing: Pricing
    status: str
    """Provider-native status text, e.g. IBM's status_msg ('active') or
    Braket's device status ('ONLINE'/'OFFLINE'/'RETIRED') — free text, kept
    as-is per provider vocabulary for telemetry/history context."""
    operational: bool
    """Clean boolean the operational Feature/require_operational constraint
    reads — never parsed from `status` text. IBM reports this directly;
    Braket is derived as status == 'ONLINE'."""
    last_calibrated_at: datetime | None
    """Most recent calibration timestamp, if the provider reports one."""
    raw_calibration: Any | None = None
    """Provider-native calibration object, only set where the Qiskit Target
    conversion drops real data qrb still wants (Braket: a
    braket.device_schema.standardized... StandardizedGateModelQpuDeviceProperties,
    whose T1/T2/gate-fidelity fields don't survive qiskit_braket_provider's
    conversion to Target.qubit_properties). None for IBM, where Target
    already carries everything (see qrb.calibration)."""
    native_calibration: Any | None = None
    """Vendor-native device.properties.provider object (Braket only, e.g.
    braket.device_schema.ionq.IonqProviderProperties) — a different object
    from raw_calibration's cross-vendor "standardized" schema, shaped
    differently per vendor. Only consulted as a last-resort fallback for
    values the standardized schema leaves unpopulated for a given vendor
    (e.g. IonQ's 1-qubit gate fidelity — see qrb.calibration). None for
    IBM and for any Braket vendor where the standardized schema already
    has everything qrb reads."""

    @property
    def candidate_id(self) -> str:
        return f"{self.provider_id}.{sanitize_identifier(self.resource_id)}"


class Provider(Protocol):
    """A read-only adapter that fetches the live device catalog for one
    access platform. Never submits jobs (ADR 0002).
    """

    provider_id: str

    def fetch_catalog(self) -> list[ResourceRecord]: ...
