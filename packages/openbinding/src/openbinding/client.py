"""Synchronous HTTP client for the OpenBinding gateway."""

from __future__ import annotations

import time

import httpx

from openbinding.models import (
    AnalyzeResponse,
    BindingSpacePage,
    EngineInfo,
    Instance,
    JobResponse,
    JobStatus,
    SolveRequest,
    SolveResponse,
)

DEFAULT_BASE_URL = "https://openbinding.score.us.es/api"


class SolveFailedError(RuntimeError):
    """Raised when an OpenBinding solve job finishes with status 'failed'."""


class OpenBindingClient:
    """Thin, typed wrapper over the OpenBinding gateway's HTTP API."""

    def __init__(self, base_url: str = DEFAULT_BASE_URL, *, timeout: float = 30.0) -> None:
        self._http = httpx.Client(base_url=base_url, timeout=timeout)

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> "OpenBindingClient":
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()

    def health(self) -> bool:
        response = self._http.get("/health")
        response.raise_for_status()
        return response.json().get("status") == "ok"

    def engines(self) -> list[EngineInfo]:
        response = self._http.get("/v1/engines")
        response.raise_for_status()
        return [EngineInfo.model_validate(e) for e in response.json()]

    def submit_solve(
        self,
        engine_id: str,
        instance: Instance,
        *,
        options: dict | None = None,
        verbose: bool = False,
    ) -> JobResponse:
        """POST /v1/solve. The gateway may answer synchronously (status=completed,
        result populated) or asynchronously (status=queued, poll job() for the result).
        """
        request = SolveRequest(engine_id=engine_id, instance=instance, options=options, verbose=verbose)
        response = self._http.post(
            "/v1/solve", json=request.model_dump(mode="json", by_alias=True, exclude_none=True)
        )
        response.raise_for_status()
        return JobResponse.model_validate(response.json())

    def solve(
        self,
        engine_id: str,
        instance: Instance,
        *,
        options: dict | None = None,
        verbose: bool = False,
        poll_interval: float = 0.5,
        timeout: float = 60.0,
    ) -> SolveResponse:
        """Submit a solve request and block until the job completes.

        Handles both the synchronous (200, already completed) and asynchronous
        (202, queued — polled via GET /v1/jobs/{id}) gateway response shapes.
        """
        job = self.submit_solve(engine_id, instance, options=options, verbose=verbose)
        deadline = time.monotonic() + timeout
        while job.status not in (JobStatus.COMPLETED, JobStatus.FAILED):
            if time.monotonic() >= deadline:
                raise TimeoutError(f"OpenBinding job {job.job_id} did not finish within {timeout}s")
            time.sleep(poll_interval)
            job = self.job(job.job_id)

        if job.status == JobStatus.FAILED:
            raise SolveFailedError(job.error or f"job {job.job_id} failed with no error message")
        assert job.result is not None
        return job.result

    def analyze(self, engine_id: str, instance: Instance) -> AnalyzeResponse:
        payload = {"engine_id": engine_id, "instance": instance.model_dump(mode="json", by_alias=True)}
        response = self._http.post("/v1/analyze", json=payload)
        response.raise_for_status()
        return AnalyzeResponse.model_validate(response.json())

    def binding_space(
        self,
        engine_id: str,
        instance: Instance,
        *,
        offset: int = 0,
        limit: int = 100,
    ) -> BindingSpacePage:
        payload = {
            "engine_id": engine_id,
            "instance": instance.model_dump(mode="json", by_alias=True),
            "offset": offset,
            "limit": limit,
        }
        response = self._http.post("/v1/analyze/binding-space", json=payload)
        response.raise_for_status()
        return BindingSpacePage.model_validate(response.json())

    def job(self, job_id: str) -> JobResponse:
        response = self._http.get(f"/v1/jobs/{job_id}")
        response.raise_for_status()
        return JobResponse.model_validate(response.json())
