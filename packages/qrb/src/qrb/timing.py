"""Phase-level timing for benchmarking build_selection_instance() / select():
catalog fetch, per-resource transpile, per-resource feature calculation, and
BIM instance assembly. Threaded through explicit return values rather than a
global/contextvar — nothing here needs its own thread-safety story since
build_instance()'s per-resource work is deliberately sequential (concurrent
Qiskit transpilation of a large/dense circuit hangs — see instance.py).

Pydantic dataclasses, not plain ones: apps/api/main.py uses these directly
as FastAPI response_models (nested inside SelectResponseEnvelope /
InstanceResponseEnvelope) — the same shape serves internal computation and
the wire format, no hand-translated mirror Pydantic models needed.
"""

from __future__ import annotations

from dataclasses import field
from datetime import datetime

from pydantic.dataclasses import dataclass


@dataclass(frozen=True)
class InstanceTimings:
    """Timings for build_instance() alone — no catalog fetch, since
    build_instance() is handed an already-fetched resource list."""

    preprocessing_ms: float
    """Wall time of circuit_width() + circuit.depth() on the untranspiled
    input circuit, before any per-resource work starts. Timed explicitly so
    it doesn't silently inflate build_instance_ms."""

    transpile_ms: float
    """Summed across every resource. The per-resource fan-out runs
    sequentially, not in parallel (see build_instance())."""

    features_ms: float
    """Summed across every resource, same caveat as transpile_ms."""

    build_instance_ms: float
    """Wall time of instance assembly alone (normalization + Candidate/
    Instance construction) — real latency, not summed, since this part
    runs single-threaded after the per-resource fan-out completes."""

    total_ms: float
    """Real wall-clock time of the whole build_instance() call — approx.
    preprocessing_ms + transpile_ms + features_ms + build_instance_ms, since
    every step is sequential (no parallelism gap to explain a difference)."""

    per_resource: dict[str, dict[str, float | None]] = field(default_factory=dict)
    """candidate_id -> {"transpile_ms", "features_ms", "depth_pre",
    "depth_post", "num_two_qubit_gates"}. depth_pre is the input circuit's
    depth (identical across every resource in one build_instance() call);
    depth_post/num_two_qubit_gates are None for a resource that didn't
    transpile (infeasible — see infeasible_reasons below)."""

    infeasible_reasons: dict[str, str] = field(default_factory=dict)
    """candidate_id -> reason, only for resources where transpile_for_resource
    returned feasible=False ("insufficient_qubits" or "transpile_error") —
    see qrb.transpile.TranspileResult.infeasible_reason. Absent entries
    mean that resource transpiled fine."""


@dataclass(frozen=True)
class PhaseTimings:
    """Timings for build_selection_instance() — catalog fetch plus the
    InstanceTimings for the build_instance() call it makes."""

    catalog_ms: float
    catalog_cache_hit: bool | None
    """None when live=False (snapshot mode) — there's no cache involved,
    so "hit" doesn't apply. True/False otherwise: whether every requested
    provider's 90s-TTL cache (qrb.providers._live_cache.CatalogCache)
    was still warm, or at least one required a live fetch."""

    catalog_fetched_at: datetime | None
    """Wall-clock time the catalog data being used was actually fetched —
    None only in snapshot mode. The oldest of the per-provider fetch times
    when more than one provider is queried."""

    instance: InstanceTimings
    total_ms: float
    """catalog_ms + instance.total_ms."""
