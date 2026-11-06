"""Where the API's catalog comes from.

With a database (DATABASE_URL), the poller (apps/poller) keeps every QPU in Postgres at the speed
each part changes: queues and status every 2 minutes, IBM's calibration every 10, everything every
30 (and a Braket device as soon as it recalibrates). Each QPU is stored per calibration
(`catalog_resource`), queues as one row per tick (`catalog_status`).

A request builds the catalog from the newest row of every QPU confirmed within
QRB_CALIBRATION_MAX_AGE_SECONDS (default 7200) and applies the newest queues:

- `live=False`: the frozen snapshot, as always.
- `force_refresh=True`: fetch everything live now, store it (only changed calibrations are new
  rows), use it.
- otherwise, from storage. If the queues are over QRB_CATALOG_MAX_AGE_SECONDS old (default 900),
  fetch queues and status live (a few seconds) and store them. If no QPU is confirmed recently
  (the poller is down, or the database is new), fetch everything live.

Without a database, the previous behaviour: a live fetch through the providers' 90 s cache.

Decoded QPU rows are kept in memory by row id, and the assembled catalog by (row ids, status id),
so repeat requests cost two cheap metadata queries. Concurrent requests that find the data stale
share one live fetch.
"""

from __future__ import annotations

import logging
import os
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

import qrb_store
from qrb.catalog import fetch_catalog_timed
from qrb.live_status import LiveStatus, apply_status, fetch_live_status, statuses_of, store_items
from qrb.providers.base import ResourceRecord
from qrb.snapshot import load_resource_bytes

logger = logging.getLogger("qrb_api.catalog")

DEFAULT_MAX_AGE_SECONDS = 900.0
DEFAULT_CALIBRATION_MAX_AGE_SECONDS = 7200.0

Catalog = tuple[list[ResourceRecord], Optional[bool], Optional[datetime]]

_lock = threading.Lock()
_decoded: dict[int, ResourceRecord] = {}
"""Decoded QPU rows by id (only the current catalog's rows are kept)."""
_merged: tuple[tuple[tuple[int, ...], int | None], list[ResourceRecord], datetime] | None = None
"""The last assembled catalog: ((row ids, status id), records, as_of)."""


def _seconds(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        return default


def max_age_seconds() -> float:
    return _seconds("QRB_CATALOG_MAX_AGE_SECONDS", DEFAULT_MAX_AGE_SECONDS)


def calibration_max_age_seconds() -> float:
    return _seconds("QRB_CALIBRATION_MAX_AGE_SECONDS", DEFAULT_CALIBRATION_MAX_AGE_SECONDS)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _age(at: datetime | None) -> float:
    return float("inf") if at is None else (_now() - at).total_seconds()


def _filter(records: list[ResourceRecord], providers: Optional[list[str]]) -> list[ResourceRecord]:
    return records if not providers else [r for r in records if r.provider_id in providers]


def _fetch_all_and_store() -> tuple[list[ResourceRecord], datetime]:
    """A live fetch of every provider, stored (changed calibrations and the queues), best effort."""
    global _merged
    records, _, fetched_at = fetch_catalog_timed(live=True, force_refresh=True)
    fetched_at = fetched_at or _now()
    qrb_store.record_catalog_resources(store_items(records, fetched_at), checked_at=fetched_at, origin="request")
    qrb_store.record_catalog_status(statuses_of(records), fetched_at=fetched_at, origin="request")
    _merged = None
    return records, fetched_at


def _assemble(metas: list[qrb_store.CatalogResourceMeta], status: qrb_store.CatalogStatus | None) -> tuple[list[ResourceRecord], datetime]:
    """The QPU rows decoded (cached by id), with the status row's queues applied when it is newer
    than the rows; the data's time is the queue's."""
    global _merged
    ids = tuple(sorted(m.id for m in metas))
    key = (ids, status.id if status else None)
    if _merged is not None and _merged[0] == key:
        return _merged[1], _merged[2]
    missing = [i for i in ids if i not in _decoded]
    if missing:
        for row_id, payload in qrb_store.load_catalog_resources(missing).items():
            _decoded[row_id] = load_resource_bytes(payload)
    for stale in [i for i in _decoded if i not in ids]:
        del _decoded[stale]
    records = [_decoded[i] for i in ids if i in _decoded]
    newest_row = max(m.checked_at for m in metas)
    if status is not None and status.fetched_at >= min(m.fetched_at for m in metas):
        records = apply_status(records, [LiveStatus.from_dict(d) for d in status.statuses])
        as_of = status.fetched_at
    else:
        as_of = newest_row
    _merged = (key, records, as_of)
    return records, as_of


def _from_store() -> tuple[Catalog, bool] | None:
    """(catalog, needs_queue_refresh) from storage, or None when no QPU is confirmed recently."""
    metas = qrb_store.latest_catalog_resources_meta(_now() - timedelta(seconds=calibration_max_age_seconds()))
    if not metas:
        return None
    records, as_of = _assemble(metas, qrb_store.latest_catalog_status())
    if not records:
        return None
    return (records, True, as_of), _age(as_of) > max_age_seconds()


def _refresh_queues(records: list[ResourceRecord]) -> Catalog:
    """Queues and status live (a few seconds), stored, applied to `records`."""
    global _merged
    ids: dict[str, set[str]] = {}
    for r in records:
        ids.setdefault(r.provider_id, set()).add(r.resource_id)
    statuses = fetch_live_status(ids)
    now = _now()
    if statuses:
        qrb_store.record_catalog_status([s.to_dict() for s in statuses], fetched_at=now, origin="request")
    _merged = None  # the next read picks up the stored row
    return apply_status(records, statuses), False, now


def get_catalog(
    *,
    live: bool = True,
    force_refresh: bool = False,
    providers: Optional[list[str]] = None,
    snapshot_path: Optional[Path] = None,
) -> Catalog:
    """(records, cache_hit, fetched_at), the shape of qrb.catalog.fetch_catalog_timed.
    cache_hit is True when this request did not ask the providers itself; fetched_at is when the
    queue data was fetched."""
    if not live or not qrb_store.is_configured():
        return fetch_catalog_timed(
            live=live, snapshot_path=snapshot_path, providers=providers, force_refresh=force_refresh
        )

    if force_refresh:
        records, fetched_at = _fetch_all_and_store()
        return _filter(records, providers), False, fetched_at

    try:
        found = _from_store()
        if found is not None and not found[1]:
            records, hit, as_of = found[0]
            return _filter(records, providers), hit, as_of
    except Exception:
        # The database is unreachable (or a row will not decode): still answer, from the providers.
        logger.exception("Reading the stored catalog failed; fetching live instead.")
        return fetch_catalog_timed(live=True, providers=providers)

    with _lock:
        # Another request may have refreshed it while this one waited.
        found = _from_store()
        if found is not None and not found[1]:
            records, hit, as_of = found[0]
            return _filter(records, providers), hit, as_of
        if found is not None:
            logger.warning("Stored queues are over %.0f s old; fetching queues live.", max_age_seconds())
            records, hit, as_of = _refresh_queues(found[0][0])
            return _filter(records, providers), hit, as_of
        logger.warning("No QPU confirmed in the last %.0f s; fetching the catalog live.", calibration_max_age_seconds())
        records, fetched_at = _fetch_all_and_store()
        return _filter(records, providers), False, fetched_at


def has_fresh_stored_catalog() -> bool:
    """For startup: whether storage can answer a default request without a live fetch."""
    if not qrb_store.is_configured():
        return False
    try:
        found = _from_store()
        return found is not None and not found[1]
    except Exception:
        return False
