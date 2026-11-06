"""Catalog poller: keeps Postgres's copy of every QPU current, at the speed each part changes.

- **Queue and status** every QRB_POLLER_STATUS_SECONDS (default 120): one cheap call per QPU
  (qrb.live_status), one `catalog_status` row. Queues change by the minute.
- **IBM calibration** every QRB_POLLER_IBM_SECONDS (default 600): IBM's backends only (status,
  properties and Targets, about 2 s). IBM updates calibration several times a day per backend.
- **Everything** every QRB_POLLER_CATALOG_SECONDS (default 1800): both providers, which also
  confirms which QPUs exist (a retired one stops being confirmed and drops out).
- **A Braket device** at once when a status tick shows its calibration time moved.

Each QPU is stored per calibration (`catalog_resource`): a fetch adds a row only for QPUs whose
calibration fingerprint changed and confirms the rest, so an IBM update stores one backend, not
the whole catalog. The API builds the catalog from the newest row per QPU and applies the newest
queues. Telemetry rows (`catalog_telemetry`) are recorded on every tick. Everything is pruned
after QRB_CATALOG_RETENTION_DAYS (default 7). The first tick fetches everything.
"""

from __future__ import annotations

import logging
import os
import time
from datetime import datetime, timedelta, timezone

from dotenv import load_dotenv
from qrb.catalog import fetch_catalog_timed
from qrb.live_status import apply_status, fetch_live_status, statuses_of, store_items
from qrb.providers.base import ResourceRecord
from qrb_store import prune_catalog, record_catalog_resources, record_catalog_status, record_telemetry_sample

load_dotenv()

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-5s %(message)s")
logger = logging.getLogger("qrb_poller")

DEFAULT_STATUS_SECONDS = 120
DEFAULT_IBM_SECONDS = 600
DEFAULT_CATALOG_SECONDS = 30 * 60
DEFAULT_RETENTION_DAYS = 7

Key = tuple[str, str]


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _telemetry(records: list[ResourceRecord]) -> None:
    record_telemetry_sample(
        [
            {
                "resource_id": r.resource_id,
                "provider_id": r.provider_id,
                "vendor": r.vendor,
                "num_qubits": r.num_qubits,
                "queue_length": r.queue_length,
                "status": r.status,
                "operational": r.operational,
                "last_calibrated_at": r.last_calibrated_at,
            }
            for r in records
        ]
    )


def fetch_and_store(
    known: dict[Key, ResourceRecord],
    *,
    providers: list[str] | None = None,
    resource_ids: frozenset[str] | None = None,
    label: str,
) -> dict[Key, ResourceRecord]:
    """Fetch some QPUs whole, store the ones whose calibration changed, return `known` updated.
    A fetch of whole providers (no resource_ids) also drops QPUs those providers no longer list."""
    started = time.perf_counter()
    records, _, fetched_at = fetch_catalog_timed(live=True, providers=providers, force_refresh=True, resource_ids=resource_ids)
    fetched_at = fetched_at or _now()
    added = record_catalog_resources(store_items(records, fetched_at), checked_at=fetched_at, origin="poller")
    record_catalog_status(statuses_of(records), fetched_at=fetched_at, origin="poller")
    _telemetry(records)
    updated = dict(known)
    if resource_ids is None:
        for key in [k for k in updated if providers is None or k[0] in providers]:
            del updated[key]
    for r in records:
        updated[(r.provider_id, r.resource_id)] = r
    logger.info("%s: %d QPUs in %.1f s, %s new calibration%s", label, len(records), time.perf_counter() - started,
                added if added is not None else "no", "" if added == 1 else "s")
    return updated


def status_tick(known: dict[Key, ResourceRecord]) -> tuple[dict[Key, ResourceRecord], frozenset[str]]:
    """Queues and status of the known QPUs. Returns `known` with them applied, and the Braket
    devices whose calibration time moved (to fetch now)."""
    started = time.perf_counter()
    ids: dict[str, set[str]] = {}
    for provider, resource in known:
        ids.setdefault(provider, set()).add(resource)
    statuses = fetch_live_status(ids)
    if statuses:
        record_catalog_status([s.to_dict() for s in statuses], fetched_at=_now(), origin="poller")
    updated_list = apply_status(list(known.values()), statuses)
    _telemetry(updated_list)
    recalibrated = frozenset(
        s.resource_id
        for s in statuses
        if s.calibrated_at is not None
        and (r := known.get((s.provider_id, s.resource_id))) is not None
        and r.last_calibrated_at is not None
        and s.calibrated_at > r.last_calibrated_at
    )
    logger.info("Status: %d of %d QPUs in %.1f s%s", len(statuses), len(known), time.perf_counter() - started,
                f"; recalibrated: {', '.join(sorted(recalibrated))}" if recalibrated else "")
    return {(r.provider_id, r.resource_id): r for r in updated_list}, recalibrated


def main() -> None:
    status_every = float(os.environ.get("QRB_POLLER_STATUS_SECONDS", DEFAULT_STATUS_SECONDS))
    ibm_every = float(os.environ.get("QRB_POLLER_IBM_SECONDS", DEFAULT_IBM_SECONDS))
    catalog_every = float(os.environ.get("QRB_POLLER_CATALOG_SECONDS", DEFAULT_CATALOG_SECONDS))
    retention_days = float(os.environ.get("QRB_CATALOG_RETENTION_DAYS", DEFAULT_RETENTION_DAYS))
    logger.info("Starting catalog poller (status every %ss, IBM every %ss, everything every %ss, retention %s days)",
                status_every, ibm_every, catalog_every, retention_days)

    known: dict[Key, ResourceRecord] = {}
    next_full = next_ibm = time.monotonic()
    while True:
        started = time.monotonic()
        try:
            if not known or started >= next_full:
                known = fetch_and_store(known, label="Full catalog")
                next_full = started + catalog_every
                next_ibm = started + ibm_every
                pruned = prune_catalog(_now() - timedelta(days=retention_days))
                if pruned:
                    logger.info("Pruned %d stored QPU rows older than %s days", pruned, retention_days)
            elif started >= next_ibm:
                known = fetch_and_store(known, providers=["ibm"], label="IBM")
                next_ibm = started + ibm_every
            else:
                known, recalibrated = status_tick(known)
                if recalibrated:
                    known = fetch_and_store(known, providers=["braket"], resource_ids=recalibrated, label="Braket recalibration")
        except Exception:
            logger.exception("Poller tick failed; will retry at the next one.")
        time.sleep(max(1.0, status_every - (time.monotonic() - started)))


if __name__ == "__main__":
    main()
