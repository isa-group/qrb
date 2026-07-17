"""Fetch the Resource catalog — live from providers (default) or from a
recorded snapshot (--snapshot, reproducible and creds-free).
"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path

from qrb.providers._live_cache import parallel_map
from qrb.providers.base import ResourceRecord
from qrb.providers.braket import BraketProviderAdapter
from qrb.providers.ibm import IBMProvider
from qrb.snapshot import DEFAULT_SNAPSHOT_PATH, load_snapshot

ALL_PROVIDER_IDS = ("ibm", "braket")


def _fetch_provider_timed(
    provider_id: str,
    *,
    force_refresh: bool = False,
    resource_ids: frozenset[str] | None = None,
) -> tuple[list[ResourceRecord], bool, datetime]:
    # Eager, module-level imports above are load-bearing, not style: a
    # function-local `import` here would be the first import of these
    # modules the first time two requests call fetch_catalog_timed()
    # concurrently (parallel_map runs this per provider in separate
    # threads), and concurrent first-time imports of the same module tree
    # can deadlock in CPython's import lock (_frozen_importlib._DeadlockError).
    if provider_id == "ibm":
        return IBMProvider().fetch_catalog_timed(
            force_refresh=force_refresh, resource_ids=resource_ids
        )
    return BraketProviderAdapter().fetch_catalog_timed(
        force_refresh=force_refresh, resource_ids=resource_ids
    )


def _validate_providers(providers: list[str] | None) -> list[str]:
    wanted = providers or list(ALL_PROVIDER_IDS)
    unknown = set(wanted) - set(ALL_PROVIDER_IDS)
    if unknown:
        raise ValueError(f"Unknown provider id(s): {unknown}. Known: {ALL_PROVIDER_IDS}")
    return wanted


def fetch_catalog(
    *,
    live: bool = True,
    snapshot_path: Path | None = None,
    providers: list[str] | None = None,
) -> list[ResourceRecord]:
    """Plain catalog read — callers that don't care about cache/timing
    metadata (the CLI, the poller, the API's startup warm-up). A thin
    delegation to fetch_catalog_timed(), which fully subsumes this."""
    records, _, _ = fetch_catalog_timed(live=live, snapshot_path=snapshot_path, providers=providers)
    return records


def fetch_catalog_timed(
    *,
    live: bool = True,
    snapshot_path: Path | None = None,
    providers: list[str] | None = None,
    force_refresh: bool = False,
    resource_ids: frozenset[str] | None = None,
) -> tuple[list[ResourceRecord], bool | None, datetime | None]:
    """Same as fetch_catalog(), plus whether every requested provider was
    served from its 90s-TTL cache and when that data was actually fetched
    (wall clock) — used by the /catalog endpoints (cache/live indicator +
    "fetched at" display) and by qrb.select's benchmarking timings.

    force_refresh=True (GET /catalog?force_refresh=true) skips the cache
    read entirely — always a real live fetch — but still repopulates the
    cache with the fresh result afterward, so it doubles as an on-demand
    cache warm rather than a one-off bypass.

    fetched_at is the OLDEST of the per-provider fetch times when more than
    one provider is queried — the conservative choice: if IBM's cache just
    populated but Braket's has been sitting for a minute, the catalog as a
    whole is only as fresh as its stalest part.

    resource_ids, if given, is passed to every requested provider's own
    resource_ids filter unchanged — safe when querying both providers at
    once since IBM and Braket resource names never collide. Only used by
    scripts/experiments/experiment1_ingestion.py; see IBMProvider/
    BraketProviderAdapter.fetch_catalog_timed for why this bypasses the
    cache.
    """
    wanted = _validate_providers(providers)

    if not live:
        # Snapshot reads never touch a live provider or its cache — "hit"
        # and "fetched at" don't apply.
        records = load_snapshot(snapshot_path or DEFAULT_SNAPSHOT_PATH)
        return [r for r in records if r.provider_id in wanted], None, None

    def _fetch(provider_id: str) -> tuple[list[ResourceRecord], bool, datetime]:
        return _fetch_provider_timed(
            provider_id, force_refresh=force_refresh, resource_ids=resource_ids
        )

    per_provider = parallel_map(_fetch, wanted)
    records = [record for records, _, _ in per_provider for record in records]
    cache_hit = all(hit for _, hit, _ in per_provider)
    fetched_at = min((fa for _, _, fa in per_provider), default=None)
    return records, cache_hit, fetched_at
