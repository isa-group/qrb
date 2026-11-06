"""The fast-changing part of the catalog: each QPU's queue length and status, fetched on its own.

A full catalog fetch (qrb.catalog) builds every QPU's Qiskit Target and reads its calibration,
which changes about once a day. Queues change by the minute. `fetch_live_status()` asks only for
what changes quickly, so the poller can refresh it every couple of minutes cheaply:

- IBM: `backend.status()` per backend (pending jobs, operational, status message). The backend
  list comes from `service.backends()`; no `properties()` (the large calibration payload).
- Braket: one `GetDevice` call per QPU, which carries the queue depth, the status and the
  device's calibration time, read from the raw response without building a Target. A changed
  calibration time tells the poller to fetch the full catalog now.

Callers pass the resource ids they care about (those of the stored full catalog), so devices
QRB does not bind to (annealers, analog simulators) are never queried.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime

from qrb.providers._live_cache import parallel_map


@dataclass(frozen=True)
class LiveStatus:
    resource_id: str
    provider_id: str
    queue_length: int | None
    status: str
    operational: bool
    calibrated_at: datetime | None = None
    """Braket only: the device's calibration time (properties.service.updatedAt). None for IBM,
    whose calibration time is only in the full fetch."""

    def to_dict(self) -> dict:
        return {
            "resource_id": self.resource_id,
            "provider_id": self.provider_id,
            "queue_length": self.queue_length,
            "status": self.status,
            "operational": self.operational,
            "calibrated_at": self.calibrated_at.isoformat() if self.calibrated_at else None,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "LiveStatus":
        cal = d.get("calibrated_at")
        return cls(
            resource_id=d["resource_id"],
            provider_id=d["provider_id"],
            queue_length=d.get("queue_length"),
            status=d.get("status", "unknown"),
            operational=bool(d.get("operational", False)),
            calibrated_at=datetime.fromisoformat(cal) if cal else None,
        )


def _ibm_status(resource_ids: frozenset[str]) -> list[LiveStatus]:
    from qrb.providers.ibm import IBMProvider

    backend_lists = parallel_map(lambda service: service.backends(), IBMProvider()._services())  # noqa: SLF001
    backends = [b for bl in backend_lists for b in bl if b.name in resource_ids]

    def one(backend) -> LiveStatus:
        try:
            s = backend.status()
            return LiveStatus(backend.name, "ibm", s.pending_jobs, s.status_msg, bool(s.operational))
        except Exception:
            return LiveStatus(backend.name, "ibm", None, "unknown", False)

    # A backend visible from several instances is one resource: keep the shortest queue, as the
    # full fetch does.
    by_name: dict[str, LiveStatus] = {}
    for st in parallel_map(one, backends):
        prev = by_name.get(st.resource_id)
        if prev is None or (st.queue_length if st.queue_length is not None else float("inf")) < (
            prev.queue_length if prev.queue_length is not None else float("inf")
        ):
            by_name[st.resource_id] = st
    return list(by_name.values())


def _braket_queue(info: list[dict]) -> int | None:
    sizes = [i.get("queueSize") for i in info or [] if i.get("queue") == "QUANTUM_TASKS_QUEUE"]
    if not sizes:
        return None
    total = 0
    for size in sizes:
        digits = "".join(ch for ch in str(size) if ch.isdigit())
        total += int(digits) if digits else 0
    return total


def _braket_status(resource_ids: frozenset[str]) -> list[LiveStatus]:
    from braket.aws.aws_device import AwsDevice
    from braket.aws.aws_session import AwsSession

    from qrb.providers.braket import _search_region

    session = AwsSession()
    per_region = parallel_map(_search_region, [(session, region) for region in AwsDevice.REGIONS])
    seen: dict[str, AwsSession] = {}
    for region_session, arns in per_region:
        for arn in arns:
            seen.setdefault(arn, region_session)

    def one(item: tuple[str, AwsSession]) -> LiveStatus | None:
        arn, region_session = item
        try:
            d = region_session.get_device(arn)
        except Exception:
            return None
        name = d.get("deviceName") or arn.rsplit("/", 1)[-1]
        if name not in resource_ids:
            return None
        calibrated_at = None
        try:
            updated = json.loads(d.get("deviceCapabilities") or "{}").get("service", {}).get("updatedAt")
            calibrated_at = datetime.fromisoformat(updated) if updated else None
        except Exception:
            calibrated_at = None
        status = str(d.get("deviceStatus", "unknown"))
        return LiveStatus(name, "braket", _braket_queue(d.get("deviceQueueInfo", [])), status, status == "ONLINE", calibrated_at)

    return [s for s in parallel_map(one, list(seen.items())) if s is not None]


def fetch_live_status(resource_ids: dict[str, set[str]] | dict[str, frozenset[str]]) -> list[LiveStatus]:
    """Queue and status of the given resources, by provider id (`{"ibm": {...}, "braket": {...}}`).
    A provider that fails is skipped (its stored values stay); the others still answer."""
    jobs = [(p, frozenset(ids)) for p, ids in resource_ids.items() if ids]

    def run(job: tuple[str, frozenset[str]]) -> list[LiveStatus]:
        provider, ids = job
        try:
            return _ibm_status(ids) if provider == "ibm" else _braket_status(ids)
        except Exception:
            import logging

            logging.getLogger(__name__).exception("Live status for %s failed", provider)
            return []

    return [s for statuses in parallel_map(run, jobs) for s in statuses]


def apply_status(records: list, statuses: list[LiveStatus]) -> list:
    """The records with queue length, status and operational replaced by the given live status
    (records without one keep their own values)."""
    from dataclasses import replace

    by_id = {(s.provider_id, s.resource_id): s for s in statuses}
    out = []
    for r in records:
        s = by_id.get((r.provider_id, r.resource_id))
        out.append(r if s is None else replace(r, queue_length=s.queue_length, status=s.status, operational=s.operational))
    return out


def resource_fingerprint(r) -> str:
    """Changes when this QPU's calibration (or size) changes; queue and status do not count."""
    import hashlib

    key = f"{r.provider_id}.{r.resource_id}:{r.num_qubits}:{r.last_calibrated_at.isoformat() if r.last_calibrated_at else '-'}"
    return hashlib.sha256(key.encode()).hexdigest()[:32]


def calibration_fingerprint(records: list) -> str:
    """Changes when any QPU's calibration (or the set of QPUs) changes; queue and status do not
    count. Two full fetches with the same fingerprint carry the same Targets and calibration."""
    import hashlib

    parts = sorted(
        f"{r.provider_id}.{r.resource_id}:{r.num_qubits}:{r.last_calibrated_at.isoformat() if r.last_calibrated_at else '-'}"
        for r in records
    )
    return hashlib.sha256("\n".join(parts).encode()).hexdigest()[:32]


def store_items(records: list, fetched_at: datetime) -> list[dict]:
    """Records as qrb_store.record_catalog_resources items (one gzipped ResourceSnapshot each)."""
    from qrb.snapshot import dump_resource_bytes

    return [
        {
            "provider_id": r.provider_id,
            "resource_id": r.resource_id,
            "fetched_at": fetched_at,
            "calibrated_at": r.last_calibrated_at,
            "fingerprint": resource_fingerprint(r),
            "payload": dump_resource_bytes(r),
        }
        for r in records
    ]


def statuses_of(records: list) -> list[dict]:
    """The queue/status part of records, as catalog_status entries."""
    return [
        LiveStatus(
            r.resource_id, r.provider_id, r.queue_length, r.status, r.operational,
            r.last_calibrated_at if r.provider_id == "braket" else None,
        ).to_dict()
        for r in records
    ]
