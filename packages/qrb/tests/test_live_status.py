"""Queue/status overlay and the calibration fingerprint used to skip storing unchanged catalogs."""

from dataclasses import replace
from datetime import datetime, timedelta, timezone
from pathlib import Path

from qrb.live_status import LiveStatus, _braket_queue, apply_status, calibration_fingerprint
from qrb.snapshot import load_snapshot

RECORDS = load_snapshot(Path(__file__).resolve().parents[3] / "scripts/experiments/output/shared_catalog_snapshot.json")


def test_apply_status_replaces_queue_and_status_only():
    s = LiveStatus("ibm_aachen", "ibm", 77, "maintenance", False)
    out = apply_status(RECORDS, [s])
    a = next(r for r in out if r.resource_id == "ibm_aachen")
    before = next(r for r in RECORDS if r.resource_id == "ibm_aachen")
    assert (a.queue_length, a.status, a.operational) == (77, "maintenance", False)
    assert a.target is before.target and a.last_calibrated_at == before.last_calibrated_at
    others = [r for r in out if r.resource_id != "ibm_aachen"]
    assert others == [r for r in RECORDS if r.resource_id != "ibm_aachen"]


def test_fingerprint_ignores_queues_but_not_calibration():
    fp = calibration_fingerprint(RECORDS)
    assert calibration_fingerprint([replace(r, queue_length=999, status="x") for r in RECORDS]) == fp
    shifted = [replace(r, last_calibrated_at=r.last_calibrated_at + timedelta(hours=1)) if i == 0 else r for i, r in enumerate(RECORDS)]
    assert calibration_fingerprint(shifted) != fp
    assert calibration_fingerprint(RECORDS[1:]) != fp


def test_status_dict_round_trip_and_braket_queue():
    s = LiveStatus("Garnet", "braket", 3, "ONLINE", True, datetime(2026, 11, 4, 16, 43, tzinfo=timezone.utc))
    assert LiveStatus.from_dict(s.to_dict()) == s
    assert _braket_queue([{"queue": "QUANTUM_TASKS_QUEUE", "queueSize": "12", "queuePriority": "Normal"},
                          {"queue": "QUANTUM_TASKS_QUEUE", "queueSize": "3", "queuePriority": "Priority"},
                          {"queue": "JOBS_QUEUE", "queueSize": "9"}]) == 15
    assert _braket_queue([]) is None
