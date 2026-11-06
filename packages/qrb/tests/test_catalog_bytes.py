"""A catalog stored in Postgres (gzipped CatalogSnapshot JSON) must come back as the same catalog:
the same QPUs, the same Target data and therefore the same features, plus IBM's extras."""

from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path

from qiskit import qasm3
from qiskit_ibm_runtime.models import BackendProperties

from qrb.instance import build_instance
from qrb.preferences import resolve_preferences
from qrb.snapshot import dump_catalog_bytes, load_catalog_bytes, load_snapshot

SNAPSHOT = Path(__file__).resolve().parents[3] / "scripts/experiments/output/shared_catalog_snapshot.json"
GHZ = qasm3.loads(
    'OPENQASM 3.0;\ninclude "stdgates.inc";\nqubit[3] q;\nbit[3] c;\nh q[0];\ncx q[0], q[1];\ncx q[1], q[2];\nc = measure q;\n'
)
WHEN = datetime(2026, 11, 4, 12, 0, tzinfo=timezone.utc)


def test_round_trip_keeps_every_qpu_and_its_features():
    records = load_snapshot(SNAPSHOT)
    data = dump_catalog_bytes(records, WHEN)
    assert len(data) < 400_000  # gzipped; the JSON is about 2.7 MB
    back, captured_at = load_catalog_bytes(data)
    assert captured_at == WHEN
    assert [r.candidate_id for r in back] == [r.candidate_id for r in records]
    prefs = resolve_preferences(preset="balanced")
    a, _ = build_instance(GHZ, records, prefs)
    b, _ = build_instance(GHZ, back, prefs)
    # calibration_age_hours is measured against the current time, so it moves between any two calls.
    same = lambda inst: {c.id: {k: v for k, v in c.features.items() if not k.startswith("calibration_age")} for c in inst.candidates}
    assert same(a) == same(b)


def test_round_trip_keeps_ibm_properties_and_processor():
    props = BackendProperties.from_dict(
        {
            "backend_name": "ibm_test",
            "backend_version": "1.0.0",
            "last_update_date": "2026-11-04T10:00:00+00:00",
            "qubits": [[{"name": "T1", "date": "2026-11-04T10:00:00+00:00", "unit": "us", "value": 177.0}]],
            "gates": [],
            "general": [],
        }
    )
    ibm = next(r for r in load_snapshot(SNAPSHOT) if r.provider_id == "ibm")
    back, _ = load_catalog_bytes(dump_catalog_bytes([replace(ibm, ibm_properties=props, processor="Heron r3")], WHEN))
    assert back[0].processor == "Heron r3"
    assert back[0].ibm_properties.t1(0) * 1e6 == 177.0


def test_ibm_xslow_and_unknown_gates_decode_from_a_stored_catalog():
    import gzip
    import json

    from qrb.snapshot import UnsupportedGateError, load_snapshot as _load

    ibm = next(r for r in _load(SNAPSHOT) if r.provider_id == "ibm")
    data = json.loads(gzip.decompress(dump_catalog_bytes([ibm], WHEN)))
    data["resources"][0]["instructions"] += [
        {"name": "xslow", "qargs": [0], "duration": 1e-7, "error": 1e-4},
        {"name": "vendor_new_2q", "qargs": [0, 1], "duration": None, "error": 0.01},
    ]
    back, _ = load_catalog_bytes(gzip.compress(json.dumps(data).encode()))
    t = back[0].target
    assert "xslow" in t.operation_names and t.operation_from_name("xslow").num_qubits == 1
    assert t.operation_from_name("vendor_new_2q").num_qubits == 2

    # The paper's snapshot format stays strict.
    from qrb.snapshot import ResourceSnapshot, snapshot_to_resource

    try:
        snapshot_to_resource(ResourceSnapshot.model_validate(data["resources"][0]))
    except UnsupportedGateError:
        pass
    else:
        raise AssertionError("strict decoding should refuse an unknown gate")


def test_one_qpu_round_trips_on_its_own():
    from qrb.snapshot import dump_resource_bytes, load_resource_bytes

    for r in load_snapshot(SNAPSHOT):
        back = load_resource_bytes(dump_resource_bytes(r))
        assert back.candidate_id == r.candidate_id
        assert set(back.target.operation_names) == set(r.target.operation_names)
