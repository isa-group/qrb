"""Presets: named, reusable Preferences profiles. Built-in presets ship with
QRB; users may define their own in a TOML file, merged on top.
"""

from __future__ import annotations

import tomllib
from dataclasses import dataclass, field
from pathlib import Path

import tomli_w
from openbinding import ConstraintOp

from qrb.features import OBJECTIVE_FEATURE_IDS

DEFAULT_USER_PRESETS_PATH = Path.home() / ".config" / "qrb" / "presets.toml"


@dataclass(frozen=True)
class ConstraintSpec:
    """One user-declared hard bound on a raw (non-normalized) feature —
    the generic replacement for the old fixed max_cost/min_fidelity/
    max_queue/require_operational/max_calibration_age_hours fields. Any
    qrb.features.FEATURE_REGISTRY id is a valid `feature`, including
    ones with no dedicated UI affordance (e.g. num_qubits, depth_feasible).
    Defined here (not preferences.py) so both this module's Preset and
    preferences.Preferences can import it without a circular import —
    preferences.py already imports Preset/BUILTIN_PRESETS from here."""

    feature: str
    op: ConstraintOp
    value: float


@dataclass(frozen=True)
class Preset:
    name: str
    weights: dict[str, float]
    constraints: list[ConstraintSpec] = field(default_factory=list)

    def __post_init__(self) -> None:
        unknown = set(self.weights) - set(OBJECTIVE_FEATURE_IDS)
        if unknown:
            raise ValueError(f"Preset '{self.name}' weights reference unknown features: {unknown}")


_REQUIRE_OPERATIONAL = [ConstraintSpec("operational", ConstraintOp.GE, 1.0)]
"""Every built-in preset requires operational=True — picking a resource the
provider itself reports as down is never desirable regardless of the
weighting strategy, and it's the one constraint whose sensible value (1)
doesn't depend on the circuit, shots, or provider pricing the way a
cost/fidelity/queue threshold would (those vary too much to give a safe
universal default, so we don't guess one)."""

BUILTIN_PRESETS: dict[str, Preset] = {
    "balanced": Preset(
        "balanced",
        {"expected_fidelity": 0.34, "cost": 0.33, "queue": 0.33},
        constraints=_REQUIRE_OPERATIONAL,
    ),
    "fidelity-first": Preset(
        "fidelity-first",
        {"expected_fidelity": 0.70, "cost": 0.15, "queue": 0.15},
        constraints=_REQUIRE_OPERATIONAL,
    ),
    "cheapest": Preset(
        "cheapest",
        {"expected_fidelity": 0.15, "cost": 0.70, "queue": 0.15},
        constraints=_REQUIRE_OPERATIONAL,
    ),
    "fastest": Preset(
        "fastest",
        {"expected_fidelity": 0.15, "cost": 0.15, "queue": 0.70},
        constraints=_REQUIRE_OPERATIONAL,
    ),
    # Quetschlich et al. 2025 — MQT Predictor's two exemplary figures of
    # merit (expected fidelity via the same product-of-gate-fidelities
    # formula, and critical depth via SupermarQ's 2-qubit-gate critical-path
    # ratio), weighted evenly since the paper only shows illustrative splits
    # (e.g. 25/75), not a canonical default.
    "mqt-predictor": Preset(
        "mqt-predictor",
        {"expected_fidelity": 0.5, "critical_depth": 0.5},
        constraints=_REQUIRE_OPERATIONAL,
    ),
    # Salm et al. 2020 / Weder et al. 2021 — the NISQ Analyzer's actual
    # selection logic IS the depth_feasible constraint (width and T1-derived
    # max depth); declaring it explicitly here (on top of it always being
    # enforced globally, see instance.py) is what makes this preset visibly
    # distinct from 'balanced' instead of shipping identical weights with no
    # sign of what the paper actually does. No ranking preference beyond
    # feasibility, so weights stay a neutral 'balanced' split.
    "nisq-analyzer": Preset(
        "nisq-analyzer",
        {"expected_fidelity": 0.34, "cost": 0.33, "queue": 0.33},
        constraints=[
            *_REQUIRE_OPERATIONAL,
            ConstraintSpec("depth_feasible", ConstraintOp.GE, 1.0),
        ],
    ),
    # Alvarado-Valiente et al. 2024 — the Quantum Load Balancer's Least
    # Outstanding Algorithm: pick the operational resource with the shortest
    # queue, nothing else considered.
    "q-orchestrator": Preset(
        "q-orchestrator", {"queue": 1.0}, constraints=_REQUIRE_OPERATIONAL
    ),
}


def _constraint_to_toml(spec: ConstraintSpec) -> dict:
    return {"feature": spec.feature, "op": spec.op.value, "value": spec.value}


def _constraint_from_toml(entry: dict) -> ConstraintSpec:
    return ConstraintSpec(
        feature=entry["feature"], op=ConstraintOp(entry["op"]), value=entry["value"]
    )


def load_user_presets(path: Path | None = None) -> dict[str, Preset]:
    presets_path = path or DEFAULT_USER_PRESETS_PATH
    if not presets_path.exists():
        return {}
    data = tomllib.loads(presets_path.read_text())
    presets = {}
    for name, entry in data.get("presets", {}).items():
        presets[name] = Preset(
            name=name,
            weights=dict(entry["weights"]),
            constraints=[_constraint_from_toml(c) for c in entry.get("constraints", [])],
        )
    return presets


def save_user_preset(preset: Preset, path: Path | None = None) -> None:
    presets_path = path or DEFAULT_USER_PRESETS_PATH
    presets_path.parent.mkdir(parents=True, exist_ok=True)
    data = tomllib.loads(presets_path.read_text()) if presets_path.exists() else {"presets": {}}
    entry: dict = {"weights": preset.weights}
    if preset.constraints:
        entry["constraints"] = [_constraint_to_toml(c) for c in preset.constraints]
    data.setdefault("presets", {})[preset.name] = entry
    presets_path.write_text(tomli_w.dumps(data))


def all_presets(user_path: Path | None = None) -> dict[str, Preset]:
    """Built-in presets merged with user presets; user presets of the same
    name override a built-in.
    """
    merged = dict(BUILTIN_PRESETS)
    merged.update(load_user_presets(user_path))
    return merged


def resolve_preset(name: str, user_path: Path | None = None) -> Preset:
    presets = all_presets(user_path)
    try:
        return presets[name]
    except KeyError as exc:
        raise ValueError(
            f"Unknown preset '{name}'. Available: {sorted(presets)}"
        ) from exc
