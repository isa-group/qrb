"""Shared helpers for live provider adapters (ibm.py, braket.py): a
process-wide TTL cache for a fully assembled catalog fetch, and a thread
pool helper for fanning out the many independent, blocking per-device
network calls each adapter makes (IBM: backends()/status() per instance or
backend; Braket: queue_depth() per device) instead of looping over them
serially.
"""

from __future__ import annotations

import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Callable, TypeVar

from qrb.providers.base import ResourceRecord

T = TypeVar("T")
R = TypeVar("R")

_DEFAULT_TTL_SECONDS = float(os.environ.get("QRB_CATALOG_CACHE_SECONDS", "90"))
"""90s, not 20s: a cold fetch_catalog() call is itself ~40-50s (dominated by
real IBM/AWS network latency — amazon-braket-sdk's provider.backends() does
a serial multi-region device scan we don't control; see BraketProviderAdapter).
A TTL shorter than the fetch it's caching defeats the point — almost every
interactive playground action landed on a cold cache at 20s. 90s absorbs a
normal back-and-forth editing session while still refreshing well within
the web app's own 10-minute poll interval."""


class CatalogCache:
    """Per-provider TTL cache for a fully assembled catalog fetch.

    Absorbs bursts of near-simultaneous requests (multiple browser tabs,
    manual testing) instead of re-querying the provider's API — much
    shorter than the web app's own poll interval
    (NEXT_PUBLIC_CATALOG_POLL_INTERVAL_MS, default 10 min), so it doesn't
    meaningfully stale queue lengths. Only useful for long-lived processes
    (the API); a one-shot CLI invocation never lives long enough to hit it.
    """

    def __init__(self, ttl_seconds: float = _DEFAULT_TTL_SECONDS) -> None:
        self._ttl_seconds = ttl_seconds
        self._lock = threading.Lock()
        # monotonic clock decides expiry (immune to system clock changes);
        # the wall-clock datetime alongside it exists purely so callers
        # (ultimately the /catalog UI) can show a real "fetched at HH:MM:SS"
        # timestamp — monotonic time has no meaning outside this process.
        self._entry: tuple[float, datetime, list[ResourceRecord]] | None = None

    def get(self) -> tuple[list[ResourceRecord], datetime] | None:
        with self._lock:
            if self._entry is None:
                return None
            monotonic_ts, fetched_at, records = self._entry
            if time.monotonic() - monotonic_ts > self._ttl_seconds:
                return None
            return records, fetched_at

    def set(self, records: list[ResourceRecord]) -> datetime:
        fetched_at = datetime.now(timezone.utc)
        with self._lock:
            self._entry = (time.monotonic(), fetched_at, records)
        return fetched_at


def parallel_map(fn: Callable[[T], R], items: list[T]) -> list[R]:
    """Run fn(item) for each item concurrently via a thread pool.

    For fanning out independent, blocking network I/O — not CPU-bound work.
    """
    if not items:
        return []
    with ThreadPoolExecutor(max_workers=min(len(items), 16)) as pool:
        return list(pool.map(fn, items))
