"""Response additions that let a client show *why* a binding came out the
way it did, and what data it came from — without a second request.

- CatalogSource: whether the catalog was live or the frozen snapshot, and
  the as-of time of that data (live fetch time, or the snapshot's own
  captured_at).
- CandidateEvaluation: every resource the request considered, with its
  feature values and the hard constraints it violates, computed against the
  same Instance the solver received.
"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Literal, Optional

from openbinding import AttributeBoundConstraint, ConstraintOp, Instance
from openbinding.models import NumericRange
from pydantic import BaseModel
from qrb.snapshot import DEFAULT_SNAPSHOT_PATH, snapshot_captured_at


class CatalogSource(BaseModel):
    mode: Literal["live", "snapshot"]
    as_of: Optional[datetime]
    """Live: when the catalog data was fetched from the providers (oldest
    provider wins). Snapshot: the snapshot's captured_at. None only for a
    legacy snapshot file without captured_at."""
    cache_hit: Optional[bool]
    """Live only: whether every provider was served from the 90s cache."""


def catalog_source(
    *,
    live: bool,
    cache_hit: Optional[bool],
    fetched_at: Optional[datetime],
    snapshot_path: Optional[Path] = None,
) -> CatalogSource:
    if live:
        return CatalogSource(mode="live", as_of=fetched_at, cache_hit=cache_hit)
    return CatalogSource(
        mode="snapshot",
        as_of=snapshot_captured_at(snapshot_path or DEFAULT_SNAPSHOT_PATH),
        cache_hit=None,
    )


class ConstraintViolation(BaseModel):
    constraint_id: str
    feature: str
    op: ConstraintOp
    value: float | NumericRange
    actual: float


class CandidateEvaluation(BaseModel):
    candidate_id: str
    name: str
    provider_id: str
    selected: bool
    features: dict[str, float]
    """Raw features plus their *_normalized objective companions, exactly as
    sent to the solver. Empty when the candidate never reached the
    Instance (see excluded_reason)."""
    violated_constraints: list[ConstraintViolation]
    excluded_reason: Optional[str] = None
    """Set when the resource was dropped before solving (e.g.
    'transpile_error': Qiskit could not produce a circuit for it)."""


def _satisfies(actual: float, op: ConstraintOp, value: float | NumericRange) -> bool:
    if op == ConstraintOp.IN_RANGE:
        assert isinstance(value, NumericRange)
        return value.min <= actual <= value.max
    bound = float(value)  # type: ignore[arg-type]
    return {
        ConstraintOp.LE: actual <= bound,
        ConstraintOp.GE: actual >= bound,
        ConstraintOp.EQ: actual == bound,
        ConstraintOp.LT: actual < bound,
        ConstraintOp.GT: actual > bound,
    }[op]


def evaluate_candidates(
    instance: Instance,
    selected_ids: set[str],
    excluded_before_solve: dict[str, str],
    excluded_names: dict[str, str],
) -> list[CandidateEvaluation]:
    """excluded_before_solve: candidate_id -> reason, for resources that
    never made it into the Instance. excluded_names: candidate_id -> display
    name for those same resources (the Instance can't supply it)."""
    bounds = [c for c in instance.constraints if isinstance(c, AttributeBoundConstraint) and c.hard]
    evaluations = []
    for candidate in instance.candidates:
        violations = []
        for c in bounds:
            if c.candidates is not None and candidate.id not in c.candidates:
                continue
            actual = candidate.features.get(c.attribute_id)
            if actual is None or _satisfies(actual, c.op, c.value):
                continue
            violations.append(
                ConstraintViolation(
                    constraint_id=c.id,
                    feature=c.attribute_id,
                    op=c.op,
                    value=c.value,
                    actual=actual,
                )
            )
        evaluations.append(
            CandidateEvaluation(
                candidate_id=candidate.id,
                name=candidate.name,
                provider_id=candidate.provider_id,
                selected=candidate.id in selected_ids,
                features=candidate.features,
                violated_constraints=violations,
            )
        )
    for candidate_id, reason in excluded_before_solve.items():
        evaluations.append(
            CandidateEvaluation(
                candidate_id=candidate_id,
                name=excluded_names.get(candidate_id, candidate_id),
                provider_id=candidate_id.split(".", 1)[0],
                selected=False,
                features={},
                violated_constraints=[],
                excluded_reason=reason,
            )
        )
    return evaluations
