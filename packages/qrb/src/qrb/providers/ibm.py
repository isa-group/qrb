"""IBM Quantum provider adapter. Read-only: lists QPUs and their calibration
data via qiskit-ibm-runtime.
"""

from __future__ import annotations

import os
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

from qiskit_ibm_runtime import QiskitRuntimeService

from qrb.pricing import IBM_PRICING
from qrb.providers._live_cache import CatalogCache, parallel_map
from qrb.providers.base import ResourceRecord

# QiskitRuntimeService() re-authenticates against IBM Cloud IAM on every
# construction (~1.3s each). Since credentials are fixed for the process
# lifetime (loaded once at startup, see apps/api|cli main.py), the resulting
# clients are safe to build once and reuse for every fetch_catalog() call.
_service_cache: dict[tuple[str | None, str | None, str] | None, QiskitRuntimeService] = {}
_service_cache_lock = threading.Lock()
_catalog_cache = CatalogCache()


def _get_cached_service(key: tuple[str | None, str | None, str] | None) -> QiskitRuntimeService:
    with _service_cache_lock:
        service = _service_cache.get(key)
        if service is None:
            if key is None:
                service = QiskitRuntimeService()
            else:
                token, channel, instance = key
                service = QiskitRuntimeService(token=token, channel=channel, instance=instance)
            _service_cache[key] = service
        return service


class IBMProvider:
    provider_id = "ibm"

    def __init__(self, service: QiskitRuntimeService | None = None) -> None:
        self._service = service

    def _services(self) -> list[QiskitRuntimeService]:
        """One QiskitRuntimeService per configured instance (IBM Cloud CRN).

        QiskitRuntimeService pins *one* instance per service object — when
        none is passed, the SDK auto-selects a single instance via
        region/plan preference, it does not union backends across every
        instance a token can reach. An account with access to multiple
        instances ("zones") therefore only sees one zone's backends unless
        each instance is queried explicitly. QISKIT_IBM_INSTANCES (comma-
        separated CRNs) opts into that; unset, behavior is unchanged
        (QiskitRuntimeService() — a single saved/env-resolved account).
        """
        if self._service is not None:
            return [self._service]

        instances = [
            crn.strip()
            for crn in os.environ.get("QISKIT_IBM_INSTANCES", "").split(",")
            if crn.strip()
        ]
        if not instances:
            return [_get_cached_service(None)]

        token = os.environ.get("QISKIT_IBM_TOKEN")
        channel = os.environ.get("QISKIT_IBM_CHANNEL")
        return [_get_cached_service((token, channel, crn)) for crn in instances]

    def fetch_catalog(self, *, resource_ids: frozenset[str] | None = None) -> list[ResourceRecord]:
        records, _, _ = self.fetch_catalog_timed(resource_ids=resource_ids)
        return records

    def fetch_catalog_timed(
        self, *, force_refresh: bool = False, resource_ids: frozenset[str] | None = None
    ) -> tuple[list[ResourceRecord], bool, datetime]:
        """Same as fetch_catalog(), plus whether it was served from the
        90s-TTL cache and when that data was actually fetched (wall clock)
        — used by qrb.select's benchmarking timings and the /catalog
        endpoints' "fetched at" display. force_refresh=True skips the cache
        read (always a live fetch) but still repopulates the cache with the
        fresh result, same as a normal miss — a later ordinary call within
        the TTL window benefits too.

        resource_ids, if given, restricts the per-backend status()/
        properties() fan-out (see _fetch_live) to only those backend names
        — applied AFTER the batch backends() list call, which always
        returns every backend regardless of this filter (there is no
        coarser-grained IBM API to restrict). This exists for
        scripts/experiments/experiment1_ingestion.py's catalog-size sweep, so it
        always bypasses the process-wide cache — a partial catalog must
        never leak into a cache other callers expect to hold the complete
        one.
        """
        # Bypass the process-wide cache for an explicitly injected service
        # (test seam) or a resource_ids filter (experiment seam) — only the
        # env-resolved, unfiltered default path is safe to share across
        # calls/requests.
        if self._service is None and not force_refresh and resource_ids is None:
            cached = _catalog_cache.get()
            if cached is not None:
                records, fetched_at = cached
                return records, True, fetched_at

        records = self._fetch_live(resource_ids=resource_ids)

        if self._service is None and resource_ids is None:
            fetched_at = _catalog_cache.set(records)
        else:
            fetched_at = datetime.now(timezone.utc)
        return records, False, fetched_at

    def _fetch_live(self, *, resource_ids: frozenset[str] | None = None) -> list[ResourceRecord]:
        # service.backends() and backend.status()/properties() are each one
        # blocking HTTP round-trip to IBM; fan them out instead of looping
        # serially.
        backend_lists = parallel_map(lambda service: service.backends(), self._services())

        backends = [
            backend
            for backend_list in backend_lists
            for backend in backend_list
            if not backend.configuration().simulator
            and (resource_ids is None or backend.name in resource_ids)
        ]
        candidate_records = parallel_map(self._to_resource_record, backends)

        # Same physical backend can be visible from more than one instance;
        # it's still one Resource under the single "ibm" Provider (ADR 0001)
        # regardless of which instance surfaced it, so collapse by name —
        # keeping whichever sighting reports the shorter queue.
        by_backend_name: dict[str, ResourceRecord] = {}
        for record in candidate_records:
            existing = by_backend_name.get(record.resource_id)
            if existing is None or _queue(record) < _queue(existing):
                by_backend_name[record.resource_id] = record
        return list(by_backend_name.values())

    def _to_resource_record(self, backend) -> ResourceRecord:
        # status() and properties() are two independent blocking round-trips
        # to IBM — fire them concurrently instead of one after the other.
        # Different backends already run in parallel via the outer
        # parallel_map(), but within a single backend these two calls were
        # still serialized, adding a second full RTT to every backend's
        # critical path for no reason (neither call depends on the other).
        with ThreadPoolExecutor(max_workers=2) as pool:
            status_future = pool.submit(backend.status)
            properties_future = pool.submit(backend.properties)

            try:
                status = status_future.result()
                queue_length = status.pending_jobs
                operational = status.operational
                status_text = status.status_msg
            except Exception:
                queue_length = None
                operational = False
                status_text = "unknown"

            try:
                last_calibrated_at = properties_future.result().last_update_date
            except Exception:
                last_calibrated_at = None

        return ResourceRecord(
            resource_id=backend.name,
            provider_id=self.provider_id,
            vendor="IBM",
            name=backend.name,
            num_qubits=backend.num_qubits,
            target=backend.target,
            queue_length=queue_length,
            pricing=IBM_PRICING,
            status=status_text,
            operational=operational,
            last_calibrated_at=last_calibrated_at,
        )


def _queue(record: ResourceRecord) -> float:
    return record.queue_length if record.queue_length is not None else float("inf")
