"""QRB API: HTTP mirror of the CLI surface. Thin wrapper over
qrb.select() and friends — same Preferences model as the CLI, exposed as
JSON instead of flags.
"""

from __future__ import annotations

import hmac
import logging
import os
import time
from contextlib import asynccontextmanager
from dataclasses import asdict
from datetime import datetime
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse
from openbinding import ConstraintOp, Feature, Instance, OpenBindingClient, SolveResponse
from pydantic import BaseModel, ConfigDict
from pydantic.dataclasses import dataclass
from qiskit import qasm3
from qrb import (
    ConstraintSpec,
    PhaseTimings,
    build_selection_instance,
    resolve_preferences,
    select_from_instance,
)
from qrb.calibration import calibration_summary
from qrb_api.catalog_store import get_catalog, has_fresh_stored_catalog
from qrb.features import FEATURE_REGISTRY, OBJECTIVE_FEATURE_IDS, normalized_feature_spec
from qrb.presets import all_presets
from qrb_store import record_binding
from scalar_fastapi import get_scalar_api_reference

from qrb_api import docs
from qrb_api.topology import Topology, topology
from qrb_api.explain import (
    CandidateEvaluation,
    CatalogSource,
    catalog_source,
    evaluate_candidates,
)

load_dotenv()

logger = logging.getLogger("qrb_api")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Blocking, on purpose: the ASGI lifespan protocol holds off accepting
    # connections until startup completes, so this is the one place a slow
    # live fetch is actually desirable — it turns "first real request pays
    # ~50s of live IBM/Braket latency" into "container isn't ready yet",
    # which is what health checks/orchestration are for. Also warms the
    # provider-level caches this populates as a side effect (IBM's
    # QiskitRuntimeService, Braket's BraketProvider — both in
    # qrb.providers), so the actual live API calls aren't repeated
    # either, only the per-request status/queue lookups are.
    # With a stored catalog under the max age (the poller keeps one), there is nothing to warm:
    # requests read it from Postgres.
    if has_fresh_stored_catalog():
        logger.info("A recent stored catalog exists; no warm-up fetch.")
        yield
        return
    try:
        get_catalog(live=True)
        logger.info("Catalog warmed at startup.")
    except Exception:
        logger.exception(
            "Failed to warm catalog cache at startup — the first real request will fetch live instead."
        )
    yield


app = FastAPI(
    title="QRB API",
    version="0.1.0",
    description=docs.DESCRIPTION,
    openapi_tags=docs.TAGS,
    lifespan=lifespan,
)
# Gateway-to-API trust: the gateway (apps/gateway) is the only intended caller.
# Every route except /health requires X-QRB-Gateway-Secret to equal
# QRB_GATEWAY_SECRET. If QRB_GATEWAY_SECRET is unset the API fails closed
# (every request but /health gets 401) unless QRB_ALLOW_UNAUTHENTICATED=1 is
# set: a local-development opt-out that also turns on WEB_ORIGINS CORS so the
# website's dev server can call the API directly.
GATEWAY_SECRET_HEADER = "X-QRB-Gateway-Secret"
USER_ID_HEADER = "X-QRB-User-Id"
_OPEN_PATHS = frozenset({"/health"})


def _dev_opt_out() -> bool:
    return os.environ.get("QRB_ALLOW_UNAUTHENTICATED") == "1"


@app.middleware("http")
async def require_gateway_secret(request: Request, call_next):
    if request.url.path in _OPEN_PATHS:
        return await call_next(request)
    expected = os.environ.get("QRB_GATEWAY_SECRET", "")
    if not expected:
        if _dev_opt_out():
            return await call_next(request)
        logger.error(
            "QRB_GATEWAY_SECRET is not set: rejecting %s %s "
            "(set QRB_ALLOW_UNAUTHENTICATED=1 for local development only)",
            request.method,
            request.url.path,
        )
    else:
        provided = request.headers.get(GATEWAY_SECRET_HEADER, "")
        if hmac.compare_digest(provided.encode(), expected.encode()):
            return await call_next(request)
    return JSONResponse(status_code=401, content={"detail": "Missing or invalid gateway secret"})


# Only the gateway calls the API in production, so no CORS there. With the dev
# opt-out, browsers on WEB_ORIGINS may call it directly. Added after the secret
# middleware so it wraps it (answers preflights first).
if _dev_opt_out():
    _default_web_origins = "http://localhost:3000,http://localhost:3002"
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            origin.strip()
            for origin in os.environ.get("WEB_ORIGINS", _default_web_origins).split(",")
            if origin.strip()
        ],
        # The site sends credentials (the gateway's session cookie); harmless here.
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )


@app.get("/scalar", include_in_schema=False)
def scalar_docs() -> HTMLResponse:
    return get_scalar_api_reference(openapi_url=app.openapi_url, title=app.title)


class ConstraintItem(BaseModel):
    """A hard limit on one feature. A QPU that breaks it is excluded, and the response says so."""

    model_config = ConfigDict(use_attribute_docstrings=True)

    feature: str
    """Feature id, e.g. `cost`, `queue`, `num_qubits`, `operational` (the `features` that `POST /instance` returns)."""
    op: ConstraintOp
    """`<=`, `>=`, `==`, `<` or `>`. (`IN_RANGE` is not accepted here: `value` is a single number.)"""
    value: float
    """The bound, in the feature's unit: USD for `cost`, pending jobs for `queue`, 1 for a yes/no feature."""


class PreferencesRequest(BaseModel):
    """What you care about: a preset, or weights and constraints, plus optional filters."""

    model_config = ConfigDict(use_attribute_docstrings=True)

    preset: Optional[str] = None
    """A named preset from `GET /presets` (e.g. `balanced`, `nisq-analyzer`). Its weights and constraints apply."""
    weights: Optional[dict[str, float]] = None
    """Feature id to weight. Proportional: each feature is normalised to 0..1 across candidates first."""
    constraints: Optional[list[ConstraintItem]] = None
    """Hard limits; a QPU that breaks any of them is excluded."""
    require_provider: Optional[str] = None
    """Only consider QPUs from this provider: `ibm` or `braket`."""
    pareto: bool = False
    """Return every non-dominated binding (the `many-heuristic` engine) instead of one optimum."""


class SelectRequest(BaseModel):
    """A circuit and the preferences to bind it by."""

    model_config = ConfigDict(use_attribute_docstrings=True)

    circuit_qasm: str
    """The circuit, as OpenQASM 3 source."""
    preferences: PreferencesRequest = PreferencesRequest()
    shots: int = 1024
    """Shots, used only to estimate cost. Nothing is run."""
    live: bool = True
    """`true`: live provider data. `false`: the frozen catalog snapshot (2026-07-11)."""
    providers: Optional[list[str]] = None
    """Limit the catalog fetch to these providers (`ibm`, `braket`)."""
    engine_id: Optional[str] = None
    """OpenBinding engine (see `GET /engines`). Default: `minizinc-csp`, or `many-heuristic` in Pareto mode."""
    force_refresh: bool = False
    """`true`: ask IBM and Braket now (tens of seconds) and store the result as the newest catalog.
    `false` (default): use the stored catalog (queues refreshed every 2 minutes, calibration every
    10 to 30); stale data is refreshed automatically."""


class InstanceRequest(BaseModel):
    """A circuit and preferences; returns the BIM instance instead of solving it."""

    model_config = ConfigDict(use_attribute_docstrings=True)

    circuit_qasm: str
    """The circuit, as OpenQASM 3 source."""
    preferences: PreferencesRequest = PreferencesRequest()
    shots: int = 1024
    """Shots, used only to estimate cost. Nothing is run."""
    live: bool = True
    """`true`: live provider data. `false`: the frozen catalog snapshot (2026-07-11)."""
    providers: Optional[list[str]] = None
    """Limit the catalog fetch to these providers (`ibm`, `braket`)."""
    force_refresh: bool = False
    """`true`: fetch live provider data now. `false` (default): the stored catalog."""


@dataclass(frozen=True)
class TimingsResponse(PhaseTimings):
    """PhaseTimings plus the one thing only the API layer knows: how long
    the whole HTTP request took. A real extension, not a mirror — every
    other field is inherited from PhaseTimings itself, so a new field there
    shows up here for free instead of needing a hand-kept copy."""

    request_total_ms: float
    """Full handler wall time — for /select this includes the solve
    round-trip (see provenance.execution_time_ms on the result for the
    engine's own self-reported share of it); for /instance it's ~= total_ms
    plus negligible request/response overhead."""


class SelectResponseEnvelope(BaseModel):
    result: SolveResponse
    source: CatalogSource
    candidates: list[CandidateEvaluation]
    """Every resource considered, with its features and the hard
    constraints it violates — the 'why' behind result (and behind an
    INFEASIBLE result in particular)."""
    timings_ms: TimingsResponse


class InstanceResponseEnvelope(BaseModel):
    result: Instance
    source: CatalogSource
    timings_ms: TimingsResponse


class CatalogTimingsResponse(BaseModel):
    catalog_ms: float
    catalog_cache_hit: Optional[bool]
    catalog_fetched_at: Optional[datetime]
    request_total_ms: float


class CatalogDetailTimingsResponse(BaseModel):
    catalog_ms: float
    catalog_cache_hit: Optional[bool]
    catalog_fetched_at: Optional[datetime]
    calibration_ms: float
    request_total_ms: float


class RequestTimingsResponse(BaseModel):
    request_total_ms: float


class CatalogRow(BaseModel):
    """One QPU in the catalog."""

    model_config = ConfigDict(use_attribute_docstrings=True)

    candidate_id: str
    """Stable id used everywhere in the API: `<provider>.<resource>`, e.g. `ibm.ibm_aachen`, `braket.Forte_1`."""
    name: str
    provider_id: str
    """`ibm` (IBM Quantum) or `braket` (Amazon Braket)."""
    vendor: str
    """Hardware vendor: IBM, IonQ, IQM, Rigetti, AQT."""
    num_qubits: int
    queue_length: Optional[int]
    """Pending jobs at the provider, where it reports them."""
    status: str
    """The provider's own status text (`active`, `ONLINE`, ...)."""
    operational: bool
    last_calibrated_at: Optional[datetime]
    median_gate_error_2q: Optional[float] = None
    median_readout_error: Optional[float] = None


class CatalogDetail(CatalogRow):
    """A catalog entry plus its calibration summary (device medians)."""

    native_gates: list[str]
    median_t1_us: Optional[float]
    median_t2_us: Optional[float]
    median_gate_error_1q: Optional[float]


class CatalogResponseEnvelope(BaseModel):
    result: list[CatalogRow]
    source: CatalogSource
    timings_ms: CatalogTimingsResponse


class CatalogDetailResponseEnvelope(BaseModel):
    result: CatalogDetail
    source: CatalogSource
    timings_ms: CatalogDetailTimingsResponse


class EnginesResponseEnvelope(BaseModel):
    result: list[dict]
    timings_ms: RequestTimingsResponse


class PresetsResponseEnvelope(BaseModel):
    result: dict[str, dict]
    timings_ms: RequestTimingsResponse


class FeaturesResponseEnvelope(BaseModel):
    result: list[Feature]
    """Every feature an instance declares: the raw ones, then the `*_normalized` objective companions."""


def _timings_response(timings: PhaseTimings, request_total_ms: float) -> TimingsResponse:
    # vars(), not a field-by-field copy: TimingsResponse inherits every
    # PhaseTimings field, so a field added to PhaseTimings later shows up
    # here automatically instead of needing this function updated too.
    return TimingsResponse(**vars(timings), request_total_ms=request_total_ms)


def _resolve(preferences: PreferencesRequest):
    constraints = (
        [ConstraintSpec(c.feature, c.op, c.value) for c in preferences.constraints]
        if preferences.constraints is not None
        else None
    )
    return resolve_preferences(
        preset=preferences.preset,
        weights=preferences.weights,
        constraints=constraints,
        require_provider=preferences.require_provider,
        pareto=preferences.pareto,
    )


def _server_snapshot_path() -> Optional[Path]:
    """The snapshot `live: false` reads: QRB_SNAPSHOT_PATH, else the library default
    (`catalog_snapshot.json` in the working directory). Never chosen by the client."""
    configured = os.environ.get("QRB_SNAPSHOT_PATH")
    return Path(configured) if configured else None


def _load_circuit(circuit_qasm: str):
    try:
        # Source text only: never load_qasm3, which reads a string that names an
        # existing file as a path.
        return qasm3.loads(circuit_qasm)
    except Exception as exc:
        # qiskit's QASM3 importer gives a useful message for semantic errors
        # (e.g. an undefined gate) but an empty one for raw syntax errors —
        # fall back to the exception's class name so the frontend never
        # shows a blank message.
        detail = str(exc) or f"Could not parse OpenQASM3 circuit ({type(exc).__name__})"
        raise HTTPException(status_code=422, detail=detail) from exc


def _record_binding(instance: Instance, preferences, response: SolveResponse) -> None:
    record_binding(
        source="api",
        task_id=instance.tasks[0].id,
        preferences=asdict(preferences),
        feasibility=response.feasibility.value,
        engine_id=response.provenance.engine_id,
        execution_time_ms=response.provenance.execution_time_ms,
        solutions=[s.model_dump(mode="json") for s in response.solutions],
        candidates=[c.model_dump(mode="json") for c in instance.candidates],
    )


@app.get("/health", **docs.ROUTES["health"])
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/select", response_model=SelectResponseEnvelope, **docs.ROUTES["select"])
def select_endpoint(
    request: SelectRequest,
    user_id: Optional[str] = Header(None, alias=USER_ID_HEADER, include_in_schema=False),
) -> SelectResponseEnvelope:
    request_start = time.perf_counter()
    # Logged only; access decisions live in the gateway.
    logger.info("select request user_id=%r", user_id)
    circuit = _load_circuit(request.circuit_qasm)
    preferences = _resolve(request.preferences)
    try:
        catalog = get_catalog(
            live=request.live,
            force_refresh=request.force_refresh,
            providers=request.providers,
            snapshot_path=_server_snapshot_path(),
        )
        instance, timings = build_selection_instance(
            circuit, preferences, shots=request.shots, catalog=catalog
        )
        response = select_from_instance(instance, preferences, engine_id=request.engine_id)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    _record_binding(instance, preferences, response)
    selected_ids = {cid for s in response.solutions for cid in s.binding.values()}
    excluded = {
        cid: reason
        for cid, reason in timings.instance.infeasible_reasons.items()
        if reason == "transpile_error"
    }
    excluded_names: dict[str, str] = {}
    if excluded:
        # Only on the rare transpile_error path: the Instance has no entry
        # for these resources, so read their names from the catalog this
        # request used.
        resources = catalog[0]
        excluded_names = {r.candidate_id: r.name for r in resources if r.candidate_id in excluded}
    request_total_ms = (time.perf_counter() - request_start) * 1000
    return SelectResponseEnvelope(
        result=response,
        source=catalog_source(
            live=request.live,
            snapshot_path=_server_snapshot_path(),
            cache_hit=timings.catalog_cache_hit,
            fetched_at=timings.catalog_fetched_at,
        ),
        candidates=evaluate_candidates(instance, selected_ids, excluded, excluded_names),
        timings_ms=_timings_response(timings, request_total_ms),
    )


@app.post("/instance", response_model=InstanceResponseEnvelope, **docs.ROUTES["instance"])
def instance_endpoint(request: InstanceRequest) -> InstanceResponseEnvelope:
    request_start = time.perf_counter()
    circuit = _load_circuit(request.circuit_qasm)
    preferences = _resolve(request.preferences)
    try:
        catalog = get_catalog(
            live=request.live,
            force_refresh=request.force_refresh,
            providers=request.providers,
            snapshot_path=_server_snapshot_path(),
        )
        instance, timings = build_selection_instance(
            circuit, preferences, shots=request.shots, catalog=catalog
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    request_total_ms = (time.perf_counter() - request_start) * 1000
    return InstanceResponseEnvelope(
        result=instance,
        source=catalog_source(
            live=request.live,
            snapshot_path=_server_snapshot_path(),
            cache_hit=timings.catalog_cache_hit,
            fetched_at=timings.catalog_fetched_at,
        ),
        timings_ms=_timings_response(timings, request_total_ms),
    )


def _resource_to_dict(r) -> dict:
    return {
        "candidate_id": r.candidate_id,
        "name": r.name,
        "provider_id": r.provider_id,
        "vendor": r.vendor,
        "num_qubits": r.num_qubits,
        "queue_length": r.queue_length,
        "status": r.status,
        "operational": r.operational,
        "last_calibrated_at": r.last_calibrated_at,
    }


def _catalog_row(r) -> dict:
    """A list row: the resource plus the two medians the catalog compares devices by. Same
    calibration_summary as the detail endpoint, so the figures agree."""
    try:
        summary = calibration_summary(r)
        medians = {"median_gate_error_2q": summary.median_gate_error_2q, "median_readout_error": summary.median_readout_error}
    except Exception:  # a provider's calibration can be malformed; the row still lists the device
        medians = {"median_gate_error_2q": None, "median_readout_error": None}
    return {**_resource_to_dict(r), **medians}


@app.get("/catalog", response_model=CatalogResponseEnvelope, **docs.ROUTES["catalog"])
def catalog_endpoint(
    live: bool = True,
    provider: Optional[list[str]] = Query(None),
    force_refresh: bool = Query(
        False, description="Fetch live provider data now (and store it) instead of the stored catalog."
    ),
) -> CatalogResponseEnvelope:
    request_start = time.perf_counter()
    catalog_start = time.perf_counter()
    try:
        resources, cache_hit, fetched_at = get_catalog(
            live=live, snapshot_path=_server_snapshot_path(), providers=provider, force_refresh=force_refresh
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    catalog_ms = (time.perf_counter() - catalog_start) * 1000
    request_total_ms = (time.perf_counter() - request_start) * 1000
    return CatalogResponseEnvelope(
        result=[_catalog_row(r) for r in resources],
        source=catalog_source(live=live, snapshot_path=_server_snapshot_path(), cache_hit=cache_hit, fetched_at=fetched_at),
        timings_ms=CatalogTimingsResponse(
            catalog_ms=catalog_ms,
            catalog_cache_hit=cache_hit,
            catalog_fetched_at=fetched_at,
            request_total_ms=request_total_ms,
        ),
    )


@app.get("/catalog/{candidate_id}", response_model=CatalogDetailResponseEnvelope, **docs.ROUTES["catalog_detail"])
def catalog_detail_endpoint(
    candidate_id: str,
    live: bool = True,
    force_refresh: bool = Query(
        False, description="Fetch live provider data now (and store it) instead of the stored catalog."
    ),
) -> CatalogDetailResponseEnvelope:
    request_start = time.perf_counter()
    catalog_start = time.perf_counter()
    try:
        resources, cache_hit, fetched_at = get_catalog(live=live, snapshot_path=_server_snapshot_path(), force_refresh=force_refresh)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    catalog_ms = (time.perf_counter() - catalog_start) * 1000
    resource = next((r for r in resources if r.candidate_id == candidate_id), None)
    if resource is None:
        raise HTTPException(status_code=404, detail=f"Unknown candidate_id '{candidate_id}'")
    calibration_start = time.perf_counter()
    summary = calibration_summary(resource)
    calibration_ms = (time.perf_counter() - calibration_start) * 1000
    request_total_ms = (time.perf_counter() - request_start) * 1000
    return CatalogDetailResponseEnvelope(
        source=catalog_source(live=live, snapshot_path=_server_snapshot_path(), cache_hit=cache_hit, fetched_at=fetched_at),
        result={
            **_resource_to_dict(resource),
            "native_gates": summary.native_gates,
            "median_t1_us": summary.median_t1_us,
            "median_t2_us": summary.median_t2_us,
            "median_gate_error_1q": summary.median_gate_error_1q,
            "median_gate_error_2q": summary.median_gate_error_2q,
            "median_readout_error": summary.median_readout_error,
        },
        timings_ms=CatalogDetailTimingsResponse(
            catalog_ms=catalog_ms,
            catalog_cache_hit=cache_hit,
            catalog_fetched_at=fetched_at,
            calibration_ms=calibration_ms,
            request_total_ms=request_total_ms,
        ),
    )


class TopologyResponseEnvelope(BaseModel):
    result: Topology
    source: CatalogSource
    timings_ms: CatalogDetailTimingsResponse


@app.get("/catalog/{candidate_id}/topology", response_model=TopologyResponseEnvelope, **docs.ROUTES["catalog_topology"])
def catalog_topology_endpoint(
    candidate_id: str,
    live: bool = True,
    force_refresh: bool = Query(
        False, description="Fetch live provider data now (and store it) instead of the stored catalog."
    ),
) -> TopologyResponseEnvelope:
    """The device's coupling map with per-qubit and per-coupler errors, and 2D coordinates to
    draw it (computed once per device and coupling map, then cached)."""
    request_start = time.perf_counter()
    catalog_start = time.perf_counter()
    try:
        resources, cache_hit, fetched_at = get_catalog(live=live, snapshot_path=_server_snapshot_path(), force_refresh=force_refresh)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    catalog_ms = (time.perf_counter() - catalog_start) * 1000
    resource = next((r for r in resources if r.candidate_id == candidate_id), None)
    if resource is None:
        raise HTTPException(status_code=404, detail=f"Unknown candidate_id '{candidate_id}'")
    topo_start = time.perf_counter()
    result = topology(resource)
    topo_ms = (time.perf_counter() - topo_start) * 1000
    return TopologyResponseEnvelope(
        result=result,
        source=catalog_source(live=live, snapshot_path=_server_snapshot_path(), cache_hit=cache_hit, fetched_at=fetched_at),
        timings_ms=CatalogDetailTimingsResponse(
            catalog_ms=catalog_ms,
            catalog_cache_hit=cache_hit,
            catalog_fetched_at=fetched_at,
            calibration_ms=topo_ms,
            request_total_ms=(time.perf_counter() - request_start) * 1000,
        ),
    )


@app.get("/engines", response_model=EnginesResponseEnvelope, **docs.ROUTES["engines"])
def engines_endpoint() -> EnginesResponseEnvelope:
    request_start = time.perf_counter()
    with OpenBindingClient() as client:
        result = [e.model_dump() for e in client.engines()]
    request_total_ms = (time.perf_counter() - request_start) * 1000
    return EnginesResponseEnvelope(
        result=result, timings_ms=RequestTimingsResponse(request_total_ms=request_total_ms)
    )


@app.get("/features", response_model=FeaturesResponseEnvelope, **docs.ROUTES["features"])
def features_endpoint() -> FeaturesResponseEnvelope:
    # The same declarations every BIM instance carries (qrb.instance), without building one.
    specs = [*FEATURE_REGISTRY, *(normalized_feature_spec(fid) for fid in OBJECTIVE_FEATURE_IDS)]
    return FeaturesResponseEnvelope(result=[spec.to_bim_feature() for spec in specs])


@app.get("/presets", response_model=PresetsResponseEnvelope, **docs.ROUTES["presets"])
def presets_endpoint() -> PresetsResponseEnvelope:
    request_start = time.perf_counter()
    result = {
        name: {
            "weights": preset.weights,
            "constraints": [
                {"feature": c.feature, "op": c.op.value, "value": c.value}
                for c in preset.constraints
            ],
        }
        for name, preset in all_presets().items()
    }
    request_total_ms = (time.perf_counter() - request_start) * 1000
    return PresetsResponseEnvelope(
        result=result, timings_ms=RequestTimingsResponse(request_total_ms=request_total_ms)
    )
