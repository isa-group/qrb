"""record_binding()/record_telemetry_sample()/record_catalog_snapshot(): the
ways data enters these tables. Callers pass plain JSON-able primitives — this package has no
dependency on `qrb`/`openbinding` types, so CLI/API/poller each convert
their own richer objects (Preferences, Instance, SolveResponse,
ResourceRecord) to dicts before calling in.

A DB outage must not break the feature that actually matters (selection) —
write failures are logged and swallowed, never raised.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy import delete, func, select

from qrb_store.db import get_session_factory
from qrb_store.models import BindingLog, CatalogResourceRow, CatalogStatusRow, CatalogTelemetry

logger = logging.getLogger(__name__)


def record_binding(
    *,
    source: str,
    task_id: str,
    preferences: dict,
    feasibility: str,
    engine_id: str,
    execution_time_ms: float | None,
    solutions: list[dict],
    candidates: list[dict],
) -> None:
    session_factory = get_session_factory()
    if session_factory is None:
        return
    try:
        with session_factory() as session:
            session.add(
                BindingLog(
                    created_at=datetime.now(timezone.utc),
                    source=source,
                    task_id=task_id,
                    preferences=preferences,
                    feasibility=feasibility,
                    engine_id=engine_id,
                    execution_time_ms=execution_time_ms,
                    solutions=solutions,
                    candidates=candidates,
                )
            )
            session.commit()
    except Exception:
        logger.exception("Failed to record binding_log row — continuing without it.")


def record_telemetry_sample(samples: list[dict]) -> None:
    """Each sample: resource_id, provider_id, vendor, num_qubits,
    queue_length, status, operational, last_calibrated_at."""
    session_factory = get_session_factory()
    if session_factory is None:
        return
    sampled_at = datetime.now(timezone.utc)
    try:
        with session_factory() as session:
            for sample in samples:
                session.add(CatalogTelemetry(sampled_at=sampled_at, **sample))
            session.commit()
    except Exception:
        logger.exception("Failed to record catalog_telemetry rows — continuing without it.")


# ---------- stored catalogs ----------


@dataclass(frozen=True)
class CatalogResourceMeta:
    id: int
    provider_id: str
    resource_id: str
    fetched_at: datetime
    checked_at: datetime
    fingerprint: str


@dataclass(frozen=True)
class CatalogStatus:
    id: int
    fetched_at: datetime
    origin: str
    statuses: list[dict]


def _latest_per_resource(session, since: datetime | None = None):
    """The newest row of each QPU (by id), optionally only those confirmed since `since`."""
    newest = (
        select(CatalogResourceRow.provider_id, CatalogResourceRow.resource_id, func.max(CatalogResourceRow.id).label("id"))
        .group_by(CatalogResourceRow.provider_id, CatalogResourceRow.resource_id)
        .subquery()
    )
    q = select(CatalogResourceRow).join(newest, CatalogResourceRow.id == newest.c.id)
    if since is not None:
        q = q.where(CatalogResourceRow.checked_at >= since)
    return session.execute(q).scalars().all()


def record_catalog_resources(resources: list[dict], *, checked_at: datetime, origin: str) -> int | None:
    """Store a fetch of some QPUs. Each item: provider_id, resource_id, fetched_at, calibrated_at,
    fingerprint, payload (qrb.snapshot.dump_resource_bytes). A QPU whose newest row has the same
    fingerprint is only confirmed (checked_at moves); the others get a new row. Returns how many
    rows were added, or None without a database or on a failed write (logged)."""
    session_factory = get_session_factory()
    if session_factory is None:
        return None
    try:
        with session_factory() as session:
            latest = {(r.provider_id, r.resource_id): r for r in _latest_per_resource(session)}
            added = 0
            for item in resources:
                row = latest.get((item["provider_id"], item["resource_id"]))
                if row is not None and row.fingerprint == item["fingerprint"]:
                    row.checked_at = max(checked_at, row.checked_at)
                    continue
                session.add(
                    CatalogResourceRow(
                        provider_id=item["provider_id"],
                        resource_id=item["resource_id"],
                        fetched_at=item["fetched_at"],
                        checked_at=checked_at,
                        calibrated_at=item.get("calibrated_at"),
                        fingerprint=item["fingerprint"],
                        origin=origin,
                        payload=item["payload"],
                    )
                )
                added += 1
            session.commit()
            return added
    except Exception:
        logger.exception("Failed to store catalog_resource rows — continuing without them.")
        return None


def latest_catalog_resources_meta(confirmed_since: datetime) -> list[CatalogResourceMeta]:
    """The newest row of every QPU confirmed since `confirmed_since`, without payloads: the
    current catalog. A QPU no fetch has listed since then (retired) is left out. Read errors
    raise: the caller decides whether to fall back to a live fetch."""
    session_factory = get_session_factory()
    if session_factory is None:
        return []
    with session_factory() as session:
        return [
            CatalogResourceMeta(
                id=r.id,
                provider_id=r.provider_id,
                resource_id=r.resource_id,
                fetched_at=r.fetched_at,
                checked_at=r.checked_at,
                fingerprint=r.fingerprint,
            )
            for r in _latest_per_resource(session, since=confirmed_since)
        ]


def load_catalog_resources(ids: list[int]) -> dict[int, bytes]:
    """Payloads of the given rows, by id (missing ids are absent)."""
    session_factory = get_session_factory()
    if session_factory is None or not ids:
        return {}
    with session_factory() as session:
        rows = session.execute(select(CatalogResourceRow.id, CatalogResourceRow.payload).where(CatalogResourceRow.id.in_(ids))).all()
        return {r.id: r.payload for r in rows}


def record_catalog_status(statuses: list[dict], *, fetched_at: datetime, origin: str) -> int | None:
    """Store every QPU's queue length and status at one moment (qrb.live_status.LiveStatus
    dicts). Returns the row id, or None without a database or on a failed write (logged)."""
    session_factory = get_session_factory()
    if session_factory is None:
        return None
    try:
        with session_factory() as session:
            row = CatalogStatusRow(fetched_at=fetched_at, origin=origin, statuses=statuses)
            session.add(row)
            session.commit()
            return row.id
    except Exception:
        logger.exception("Failed to store catalog_status — continuing without it.")
        return None


def latest_catalog_status() -> CatalogStatus | None:
    """The newest queue/status row, or None. Read errors raise (the caller falls back)."""
    session_factory = get_session_factory()
    if session_factory is None:
        return None
    with session_factory() as session:
        row = session.execute(
            select(CatalogStatusRow).order_by(CatalogStatusRow.fetched_at.desc(), CatalogStatusRow.id.desc()).limit(1)
        ).scalar_one_or_none()
        if row is None:
            return None
        return CatalogStatus(id=row.id, fetched_at=row.fetched_at, origin=row.origin, statuses=list(row.statuses))


def prune_catalog(older_than: datetime) -> int:
    """Delete QPU rows and queue/status rows older than `older_than`; returns how many QPU rows.
    Each QPU's newest row is kept however old (a calibration can stay current for long)."""
    session_factory = get_session_factory()
    if session_factory is None:
        return 0
    try:
        with session_factory() as session:
            keep = [r.id for r in _latest_per_resource(session)]
            result = session.execute(
                delete(CatalogResourceRow).where(CatalogResourceRow.checked_at < older_than, CatalogResourceRow.id.not_in(keep or [-1]))
            )
            session.execute(delete(CatalogStatusRow).where(CatalogStatusRow.fetched_at < older_than))
            session.commit()
            return result.rowcount or 0
    except Exception:
        logger.exception("Failed to prune the stored catalog — will retry next tick.")
        return 0
