"""qrb.select() — the orchestration entry point: circuit + declared
Preferences → BIM instance → solve via OpenBinding → Binding(s). Both the
CLI and the API call this; call graph is apps → qrb → openbinding.
"""

from __future__ import annotations

import time
from pathlib import Path

from openbinding import Instance, OpenBindingClient, SolveResponse
from openbinding.client import DEFAULT_BASE_URL
from qiskit.circuit import QuantumCircuit

from qrb.catalog import fetch_catalog_timed
from qrb.instance import build_instance
from qrb.preferences import Preferences
from qrb.timing import PhaseTimings
from qrb.transpile import DEFAULT_OPTIMIZATION_LEVEL, DEFAULT_TRANSPILER_SEED

MONO_ENGINE = "minizinc-csp"
"""The only EXACT solver — the provably optimal feasible binding."""

MANY_ENGINE = "many-heuristic"
"""Pareto/multi-objective solver, used when Preferences.pareto is set."""


def default_engine_for(preferences: Preferences) -> str:
    return MANY_ENGINE if preferences.pareto else MONO_ENGINE


def build_selection_instance(
    circuit: QuantumCircuit,
    preferences: Preferences,
    *,
    shots: int = 1024,
    live: bool = True,
    snapshot_path: Path | None = None,
    providers: list[str] | None = None,
    optimization_level: int = DEFAULT_OPTIMIZATION_LEVEL,
    transpiler_seed: int = DEFAULT_TRANSPILER_SEED,
    force_refresh: bool = True,
) -> tuple[Instance, PhaseTimings]:
    """Build the BIM instance without solving — backs `qrb instance` /
    `POST /instance` for inspection and paper artifacts.

    force_refresh defaults to True: this builds toward a real binding
    decision, not a browsing view, so it should by default reflect the
    true current queue/status rather than up-to-90s-stale cached data (see
    /catalog for the cached, fast-by-default path browsing actually
    wants). Callers that want faster, cache-permitting iteration (e.g. the
    Playground re-resolving after only a preference tweak, not a catalog
    change) can pass force_refresh=False. No-op either way when live=False
    (snapshot mode never touches the cache regardless).
    """
    catalog_start = time.perf_counter()
    resources, catalog_cache_hit, catalog_fetched_at = fetch_catalog_timed(
        live=live, snapshot_path=snapshot_path, providers=providers, force_refresh=force_refresh
    )
    catalog_ms = (time.perf_counter() - catalog_start) * 1000

    instance, instance_timings = build_instance(
        circuit,
        resources,
        preferences,
        shots=shots,
        optimization_level=optimization_level,
        transpiler_seed=transpiler_seed,
    )
    timings = PhaseTimings(
        catalog_ms=catalog_ms,
        catalog_cache_hit=catalog_cache_hit,
        catalog_fetched_at=catalog_fetched_at,
        instance=instance_timings,
        total_ms=catalog_ms + instance_timings.total_ms,
    )
    return instance, timings


def select_from_instance(
    instance: Instance,
    preferences: Preferences,
    *,
    engine_id: str | None = None,
    base_url: str = DEFAULT_BASE_URL,
) -> SolveResponse:
    """Solve an already-built Instance — split out of select() so callers
    that need the Instance too (e.g. to log the full candidate set a
    decision was drawn from) can build it once and reuse it, instead of
    fetching the catalog twice.
    """
    resolved_engine = engine_id or default_engine_for(preferences)
    with OpenBindingClient(base_url=base_url) as client:
        return client.solve(resolved_engine, instance)


def select(
    circuit: QuantumCircuit,
    preferences: Preferences,
    *,
    shots: int = 1024,
    live: bool = True,
    snapshot_path: Path | None = None,
    providers: list[str] | None = None,
    engine_id: str | None = None,
    optimization_level: int = DEFAULT_OPTIMIZATION_LEVEL,
    transpiler_seed: int = DEFAULT_TRANSPILER_SEED,
    base_url: str = DEFAULT_BASE_URL,
    force_refresh: bool = True,
) -> tuple[SolveResponse, PhaseTimings]:
    instance, timings = build_selection_instance(
        circuit,
        preferences,
        shots=shots,
        live=live,
        snapshot_path=snapshot_path,
        providers=providers,
        optimization_level=optimization_level,
        transpiler_seed=transpiler_seed,
        force_refresh=force_refresh,
    )
    response = select_from_instance(instance, preferences, engine_id=engine_id, base_url=base_url)
    return response, timings
