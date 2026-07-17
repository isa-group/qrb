"""Reusable evaluation suite: shared helpers for the three experiments
(experiment1/2/3)."""

from __future__ import annotations

import csv
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from qrb.features import FEATURE_REGISTRY, OBJECTIVE_FEATURE_IDS, normalized_feature_id
from qrb.providers.base import ResourceRecord

REPO_ROOT = Path(__file__).resolve().parents[2]
OUTPUT_DIR = Path(__file__).resolve().parent / "output"
SHARED_SNAPSHOT_PATH = OUTPUT_DIR / "shared_catalog_snapshot.json"

RAW_FEATURE_IDS: list[str] = [spec.id for spec in FEATURE_REGISTRY]
NORMALIZED_FEATURE_IDS: list[str] = [normalized_feature_id(fid) for fid in OBJECTIVE_FEATURE_IDS]
ALL_FEATURE_COLUMNS: list[str] = [*RAW_FEATURE_IDS, *NORMALIZED_FEATURE_IDS]


def utc_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


def ensure_output_dir() -> Path:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    return OUTPUT_DIR


def write_csv(path: Path, fieldnames: list[str], rows: list[dict[str, Any]]) -> None:
    ensure_output_dir()
    with path.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def sorted_resource_ids(resources: list[ResourceRecord]) -> list[str]:
    """Alphabetical by resource_id — the fixed ordering nested device
    subsets are built from (see nested_subsets)."""
    return sorted(r.resource_id for r in resources)


def nested_subsets(sorted_ids: list[str], sizes: list[int]) -> dict[int, list[str]]:
    """size -> the first `size` names in sorted_ids — size=2 is a subset of
    size=4 is a subset of size=6, etc. Errors loudly if a requested size
    exceeds how many ids are available (a config mistake, not a thing to
    silently truncate)."""
    subsets = {}
    for size in sizes:
        if size > len(sorted_ids):
            raise ValueError(
                f"Requested subset size {size} exceeds {len(sorted_ids)} available ids: {sorted_ids}"
            )
        subsets[size] = sorted_ids[:size]
    return subsets


def feature_columns_for(features: dict[str, float] | None) -> dict[str, float | None]:
    """features is a Candidate.features dict (raw + normalized merged) or
    None for a resource that never made it into the Instance (transpile_error,
    excluded per instance.py) — every column is present either way, None
    when there's genuinely nothing to report."""
    if features is None:
        return dict.fromkeys(ALL_FEATURE_COLUMNS)
    return {col: features.get(col) for col in ALL_FEATURE_COLUMNS}
