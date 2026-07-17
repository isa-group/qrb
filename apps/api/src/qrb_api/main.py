"""QRB API: HTTP mirror of the CLI surface. Thin wrapper over
qrb.select() and friends — same Preferences model as the CLI, exposed as
JSON instead of flags.
"""

from __future__ import annotations

import logging
import os
import time
from contextlib import asynccontextmanager
from dataclasses import asdict
from datetime import datetime
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from openbinding import ConstraintOp, Instance, OpenBindingClient, SolveResponse
from pydantic import BaseModel
from pydantic.dataclasses import dataclass
from qrb import (
    ConstraintSpec,
    PhaseTimings,
    build_selection_instance,
    load_qasm3,
    resolve_preferences,
    select_from_instance,
)
from qrb.calibration import calibration_summary
from qrb.catalog import fetch_catalog, fetch_catalog_timed
from qrb.presets import all_presets
from qrb_store import record_binding
from scalar_fastapi import get_scalar_api_reference

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
    try:
        fetch_catalog(live=True)
        logger.info("Catalog cache warmed at startup.")
    except Exception:
        logger.exception(
            "Failed to warm catalog cache at startup — the first real request will fetch live instead."
        )
    yield


app = FastAPI(title="QRB API", lifespan=lifespan)
_default_web_origins = "http://localhost:3000,http://localhost:3002"
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        origin.strip()
        for origin in os.environ.get("WEB_ORIGINS", _default_web_origins).split(",")
        if origin.strip()
    ],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/scalar", include_in_schema=False)
def scalar_docs() -> HTMLResponse:
    return get_scalar_api_reference(openapi_url=app.openapi_url, title=app.title)


class ConstraintItem(BaseModel):
    feature: str
    op: ConstraintOp
    value: float


class PreferencesRequest(BaseModel):
    preset: Optional[str] = None
    weights: Optional[dict[str, float]] = None
    constraints: Optional[list[ConstraintItem]] = None
    require_provider: Optional[str] = None
    pareto: bool = False


class SelectRequest(BaseModel):
    circuit_qasm: str
    preferences: PreferencesRequest = PreferencesRequest()
    shots: int = 1024
    live: bool = True
    snapshot_path: Optional[str] = None
    providers: Optional[list[str]] = None
    engine_id: Optional[str] = None
    force_refresh: bool = True
    """Skip the 90s catalog cache and always fetch live. Defaults to True —
    a resolved binding is a real decision, not a browsing view — but the
    Playground can opt out for faster iteration when only preferences
    changed, not the catalog."""


class InstanceRequest(BaseModel):
    circuit_qasm: str
    preferences: PreferencesRequest = PreferencesRequest()
    shots: int = 1024
    live: bool = True
    snapshot_path: Optional[str] = None
    providers: Optional[list[str]] = None
    force_refresh: bool = True


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
    timings_ms: TimingsResponse


class InstanceResponseEnvelope(BaseModel):
    result: Instance
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


class CatalogResponseEnvelope(BaseModel):
    result: list[dict]
    timings_ms: CatalogTimingsResponse


class CatalogDetailResponseEnvelope(BaseModel):
    result: dict
    timings_ms: CatalogDetailTimingsResponse


class EnginesResponseEnvelope(BaseModel):
    result: list[dict]
    timings_ms: RequestTimingsResponse


class PresetsResponseEnvelope(BaseModel):
    result: dict[str, dict]
    timings_ms: RequestTimingsResponse


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


def _load_circuit(circuit_qasm: str):
    try:
        return load_qasm3(circuit_qasm)
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


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/select", response_model=SelectResponseEnvelope)
def select_endpoint(request: SelectRequest) -> SelectResponseEnvelope:
    request_start = time.perf_counter()
    circuit = _load_circuit(request.circuit_qasm)
    preferences = _resolve(request.preferences)
    snapshot_path = Path(request.snapshot_path) if request.snapshot_path else None
    try:
        instance, timings = build_selection_instance(
            circuit,
            preferences,
            shots=request.shots,
            live=request.live,
            snapshot_path=snapshot_path,
            providers=request.providers,
            force_refresh=request.force_refresh,
        )
        response = select_from_instance(instance, preferences, engine_id=request.engine_id)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    _record_binding(instance, preferences, response)
    request_total_ms = (time.perf_counter() - request_start) * 1000
    return SelectResponseEnvelope(
        result=response, timings_ms=_timings_response(timings, request_total_ms)
    )


@app.post("/instance", response_model=InstanceResponseEnvelope)
def instance_endpoint(request: InstanceRequest) -> InstanceResponseEnvelope:
    request_start = time.perf_counter()
    circuit = _load_circuit(request.circuit_qasm)
    preferences = _resolve(request.preferences)
    snapshot_path = Path(request.snapshot_path) if request.snapshot_path else None
    try:
        instance, timings = build_selection_instance(
            circuit,
            preferences,
            shots=request.shots,
            live=request.live,
            snapshot_path=snapshot_path,
            providers=request.providers,
            force_refresh=request.force_refresh,
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    request_total_ms = (time.perf_counter() - request_start) * 1000
    return InstanceResponseEnvelope(
        result=instance, timings_ms=_timings_response(timings, request_total_ms)
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


@app.get("/catalog", response_model=CatalogResponseEnvelope)
def catalog_endpoint(
    live: bool = True,
    provider: Optional[list[str]] = Query(None),
    force_refresh: bool = Query(
        False, description="Skip the 90s catalog cache and fetch live, even if it's still warm."
    ),
) -> CatalogResponseEnvelope:
    request_start = time.perf_counter()
    catalog_start = time.perf_counter()
    try:
        resources, cache_hit, fetched_at = fetch_catalog_timed(
            live=live, providers=provider, force_refresh=force_refresh
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    catalog_ms = (time.perf_counter() - catalog_start) * 1000
    request_total_ms = (time.perf_counter() - request_start) * 1000
    return CatalogResponseEnvelope(
        result=[_resource_to_dict(r) for r in resources],
        timings_ms=CatalogTimingsResponse(
            catalog_ms=catalog_ms,
            catalog_cache_hit=cache_hit,
            catalog_fetched_at=fetched_at,
            request_total_ms=request_total_ms,
        ),
    )


@app.get("/catalog/{candidate_id}", response_model=CatalogDetailResponseEnvelope)
def catalog_detail_endpoint(
    candidate_id: str,
    live: bool = True,
    force_refresh: bool = Query(
        False, description="Skip the 90s catalog cache and fetch live, even if it's still warm."
    ),
) -> CatalogDetailResponseEnvelope:
    request_start = time.perf_counter()
    catalog_start = time.perf_counter()
    try:
        resources, cache_hit, fetched_at = fetch_catalog_timed(live=live, force_refresh=force_refresh)
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


@app.get("/engines", response_model=EnginesResponseEnvelope)
def engines_endpoint() -> EnginesResponseEnvelope:
    request_start = time.perf_counter()
    with OpenBindingClient() as client:
        result = [e.model_dump() for e in client.engines()]
    request_total_ms = (time.perf_counter() - request_start) * 1000
    return EnginesResponseEnvelope(
        result=result, timings_ms=RequestTimingsResponse(request_total_ms=request_total_ms)
    )


@app.get("/presets", response_model=PresetsResponseEnvelope)
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
