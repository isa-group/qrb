"""Braket per-qubit calibration must be keyed by the Qiskit Target's qubit index.

Vendors label qubits their own way: IQM counts from 1 (QB1..QB20), Rigetti uses node ids with
gaps. The Target numbers the same qubits 0..n-1 in sorted order, and features.py looks the
per-qubit maps up with Target qargs, so the maps must use that numbering too. The check: a qubit's
per-qubit readout error equals the Target's measure error for that same qubit index.
"""

from pathlib import Path

import pytest

from qrb.calibration import calibration_summary
from qrb.snapshot import load_snapshot

SNAPSHOT = Path(__file__).resolve().parents[3] / "scripts/experiments/output/shared_catalog_snapshot.json"


@pytest.fixture(scope="module")
def resources():
    return {r.resource_id: r for r in load_snapshot(SNAPSHOT)}


@pytest.mark.parametrize("device", ["Garnet", "Emerald", "Cepheus-1-108Q"])
def test_readout_error_is_keyed_by_target_index(resources, device):
    resource = resources[device]
    summary = calibration_summary(resource)
    measure = {q[0]: p.error for q, p in resource.target["measure"].items() if p is not None and p.error is not None}
    assert summary.readout_error_by_qubit, "expected per-qubit readout data"
    assert set(summary.readout_error_by_qubit) <= set(range(resource.target.num_qubits))
    for index, error in summary.readout_error_by_qubit.items():
        assert error == pytest.approx(measure[index], abs=1e-9), f"{device} qubit {index}"


@pytest.mark.parametrize("device", ["Garnet", "Emerald", "Cepheus-1-108Q"])
def test_two_qubit_pairs_are_target_couplers(resources, device):
    resource = resources[device]
    summary = calibration_summary(resource)
    couplers = {frozenset(int(x) for x in q) for name in resource.target.operation_names for q in (resource.target[name] or {}) if q is not None and len(q) == 2}
    assert summary.gate_error_2q_by_pair, "expected per-pair data"
    assert set(summary.gate_error_2q_by_pair) <= couplers
