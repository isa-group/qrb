"""record_binding()/record_telemetry_sample(): the only two ways data enters
these tables. Callers pass plain JSON-able primitives — this package has no
dependency on `qrb`/`openbinding` types, so CLI/API/poller each convert
their own richer objects (Preferences, Instance, SolveResponse,
ResourceRecord) to dicts before calling in.

A DB outage must not break the feature that actually matters (selection) —
write failures are logged and swallowed, never raised.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from qrb_store.db import get_session_factory
from qrb_store.models import BindingLog, CatalogTelemetry

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
