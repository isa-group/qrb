"""Preferences: a user's declared Objective + Constraints for one request.
Built from a Preset, explicit weight/constraint overrides, or both — the
same model is used by the CLI (flags) and the API (JSON body).
"""

from __future__ import annotations

from dataclasses import dataclass, field

from openbinding import AttributeBoundConstraint, ManyObjective, MonoObjective
from openbinding.models import Constraint, Objective

from qrb.features import normalized_feature_id
from qrb.presets import BUILTIN_PRESETS, ConstraintSpec, Preset, resolve_preset


@dataclass(frozen=True)
class Preferences:
    weights: dict[str, float]
    constraints: list[ConstraintSpec] = field(default_factory=list)
    require_provider: str | None = None
    """Filters the candidate catalog before instance-building — Provider is
    not a Feature, so this cannot be expressed as a BIM attribute constraint."""
    pareto: bool = False
    """Selects a MANY (Pareto) objective instead of a MONO scalarization."""

    def to_objective(self) -> Objective:
        """Targets the *_normalized companion features (see
        qrb.features.normalized_feature_id) — the objective must operate
        on a comparable [0,1] scale for weights to be proportional, but the
        raw features (real dollars, real job counts) are what to_constraints
        and human-readable output use.
        """
        weights = {normalized_feature_id(k): v for k, v in self.weights.items()}
        targets = list(weights)
        if self.pareto:
            return ManyObjective(targets=targets, weights=weights)
        return MonoObjective(targets=targets, weights=weights)

    def to_constraints(self) -> list[Constraint]:
        """Hard cutoffs only — soft (hard=False) AttributeBoundConstraints
        are rejected outright by minizinc-csp's request schema, so there is
        no working non-hard mode to offer."""
        return [
            AttributeBoundConstraint(
                id=f"user_constraint_{i}_{spec.feature}",
                scope="GLOBAL",
                attribute_id=spec.feature,
                op=spec.op,
                value=spec.value,
            )
            for i, spec in enumerate(self.constraints)
        ]


def resolve_preferences(
    *,
    preset: str | None = None,
    weights: dict[str, float] | None = None,
    constraints: list[ConstraintSpec] | None = None,
    require_provider: str | None = None,
    pareto: bool = False,
    user_presets_path=None,
) -> Preferences:
    """Merge a named preset (if any) with explicit overrides. Explicit
    weights/constraints always win over the preset's, wholesale (not
    merged field-by-field) — same override semantics as weights already
    had.
    """
    base: Preset = (
        resolve_preset(preset, user_presets_path) if preset else BUILTIN_PRESETS["balanced"]
    )
    return Preferences(
        weights=weights if weights is not None else dict(base.weights),
        constraints=constraints if constraints is not None else list(base.constraints),
        require_provider=require_provider,
        pareto=pareto,
    )
