"""Amazon Braket provider adapter. Read-only: lists gate-based QPUs and their
calibration data via qiskit-braket-provider / the Braket SDK.

Note: qiskit-braket-provider only exposes gate-model devices (it already
excludes analog/annealing device families such as QuEra's Aquila, D-Wave, and
Xanadu, none of which can produce a Qiskit Target). QuEra pricing is kept in
qrb.pricing for reference but is not reachable through this adapter.
"""

from __future__ import annotations

import re
import threading
from datetime import datetime, timezone

from botocore.exceptions import ClientError
from braket.aws.aws_device import AwsDevice, AwsDeviceType
from braket.aws.aws_session import AwsSession
from braket.device_schema.dwave import DwaveDeviceCapabilities
from braket.device_schema.quera import QueraDeviceCapabilities
from braket.device_schema.xanadu import XanaduDeviceCapabilities
from qiskit_braket_provider import BraketAwsBackend, BraketProvider

from qrb.pricing import braket_pricing_for_vendor
from qrb.providers._live_cache import CatalogCache, parallel_map
from qrb.providers.base import ResourceRecord

_DIGITS = re.compile(r"\d+")
_NON_GATE_MODEL_CAPABILITIES = (
    DwaveDeviceCapabilities,
    XanaduDeviceCapabilities,
    QueraDeviceCapabilities,
)

_catalog_cache = CatalogCache()

# BraketProvider() resolves AWS credentials/session at construction time.
# Credentials are fixed for the process lifetime, so — same reasoning as
# IBM's _service_cache in ibm.py — the instance is safe to build once and
# reuse for every fetch_catalog() call instead of re-resolving on each one.
_provider_cache: BraketProvider | None = None
_provider_cache_lock = threading.Lock()


def _get_cached_provider() -> BraketProvider:
    global _provider_cache
    with _provider_cache_lock:
        if _provider_cache is None:
            _provider_cache = BraketProvider()
        return _provider_cache


def _parse_count(value: str) -> int:
    match = _DIGITS.search(value)
    return int(match.group()) if match else 0


def _search_region(item: tuple[AwsSession, str]) -> tuple[AwsSession, list[str]]:
    session, region = item
    session_region = session.boto_session.region_name
    region_session = (
        session if region == session_region else AwsSession.copy_session(session, region)
    )
    try:
        arns = [
            result["deviceArn"]
            for result in region_session.search_devices(types=[AwsDeviceType.QPU])
        ]
    except ClientError:
        # Matches AwsDevice.get_devices()'s own handling: skip an
        # unreachable region rather than failing the whole discovery.
        arns = []
    return region_session, arns


def _construct_device(item: tuple[str, AwsSession]) -> AwsDevice:
    arn, region_session = item
    return AwsDevice(arn, region_session)


def _discover_qpu_devices() -> list[AwsDevice]:
    """Reimplements AwsDevice.get_devices(types=[QPU]) with the per-region
    device search AND the per-device AwsDevice construction both
    parallelized — the SDK's own version does both serially across
    AwsDevice.REGIONS (5 regions), which dominates Braket's live catalog
    fetch latency.

    AwsDevice.get_devices() itself is public API; the pieces it's built
    from (AwsSession.search_devices, AwsSession.copy_session, the
    AwsDevice constructor) are lower-level but still public. This only
    reimplements the *parallelism* — the region list, ARN dedup (first
    seen wins), and per-region error handling are copied faithfully from
    get_devices()'s own logic. If a future braket SDK version changes
    that internal contract, this needs revisiting.
    """
    session = AwsSession()
    per_region = parallel_map(_search_region, [(session, region) for region in AwsDevice.REGIONS])

    seen: dict[str, AwsSession] = {}
    for region_session, arns in per_region:
        for arn in arns:
            seen.setdefault(arn, region_session)

    devices = parallel_map(_construct_device, list(seen.items()))
    return [d for d in devices if not isinstance(d.properties, _NON_GATE_MODEL_CAPABILITIES)]


class BraketProviderAdapter:
    provider_id = "braket"

    def __init__(self, provider: BraketProvider | None = None) -> None:
        # None means "use the env-resolved default" — only that path is
        # safe to share across calls/requests via the process-wide cache.
        self._injected_provider = provider

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

        resource_ids, if given, restricts the per-device queue_depth() fan-
        out (see _fetch_live) to only those device names — applied AFTER
        device discovery (region search + per-device AwsDevice
        construction), which always runs against every device regardless of
        this filter: unlike IBM, a device's core properties are fetched
        during AwsDevice construction itself, so only the final
        queue_depth() round-trip is actually avoided for an excluded
        device. Always bypasses the process-wide cache entirely,
        same reasoning as IBMProvider's resource_ids.
        """
        if self._injected_provider is None and not force_refresh and resource_ids is None:
            cached = _catalog_cache.get()
            if cached is not None:
                records, fetched_at = cached
                return records, True, fetched_at

        records = self._fetch_live(resource_ids=resource_ids)

        if self._injected_provider is None and resource_ids is None:
            fetched_at = _catalog_cache.set(records)
        else:
            fetched_at = datetime.now(timezone.utc)
        return records, False, fetched_at

    def _fetch_live(self, *, resource_ids: frozenset[str] | None = None) -> list[ResourceRecord]:
        if self._injected_provider is not None:
            # Test seam: _discover_qpu_devices() below operates beneath
            # BraketProvider (raw AwsSession/AwsDevice), so it has no way
            # to honor an injected fake provider — fall back to the
            # provider's own (slower) backends() so injection still works.
            qpu_backends = [
                backend
                for backend in self._injected_provider.backends()
                if isinstance(backend, BraketAwsBackend)
                and backend._device.type == AwsDeviceType.QPU  # noqa: SLF001 — no public accessor exposed
                and (resource_ids is None or backend.name in resource_ids)
            ]
            return parallel_map(self._to_resource_record, qpu_backends)

        provider = _get_cached_provider()
        devices = _discover_qpu_devices()
        if resource_ids is not None:
            devices = [d for d in devices if d.name in resource_ids]
        qpu_backends = [
            BraketAwsBackend(
                device=device,
                provider=provider,
                name=device.name,
                description=f"AWS Device: {device.provider_name} {device.name}.",
                online_date=device.properties.service.updatedAt,
                backend_version="2",
            )
            for device in devices
        ]
        # queue_depth() is one blocking HTTP round-trip to AWS per device;
        # fan them out instead of looping serially.
        return parallel_map(self._to_resource_record, qpu_backends)

    def _to_resource_record(self, backend: BraketAwsBackend) -> ResourceRecord:
        device = backend._device  # noqa: SLF001 — no public accessor exposed
        try:
            depth = backend.queue_depth()
            queue_length = sum(_parse_count(v) for v in depth.quantum_tasks.values())
        except Exception:
            queue_length = None

        # Braket only exposes the status enum, no separate operational bool
        # (unlike IBM) — ONLINE is the only status that means usable.
        status_text = str(device.status)
        operational = status_text == "ONLINE"

        try:
            last_calibrated_at = device.properties.service.updatedAt
        except Exception:
            last_calibrated_at = None

        try:
            raw_calibration = device.properties.standardized
        except Exception:
            raw_calibration = None

        try:
            native_calibration = device.properties.provider
        except Exception:
            native_calibration = None

        vendor = device.provider_name
        return ResourceRecord(
            resource_id=device.name,
            provider_id=self.provider_id,
            vendor=vendor,
            name=device.name,
            num_qubits=backend.num_qubits,
            target=backend.target,
            queue_length=queue_length,
            pricing=braket_pricing_for_vendor(vendor),
            status=status_text,
            operational=operational,
            last_calibrated_at=last_calibrated_at,
            raw_calibration=raw_calibration,
            native_calibration=native_calibration,
        )
