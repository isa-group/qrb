"""Capture the single frozen catalog snapshot shared by Experiment 2 and
Experiment 3. One dedicated live fetch of all 12 QPUs, independent of
Experiment 1 (which measures ingestion *timing*, not a dataset to reuse
elsewhere).

Usage: uv run python scripts/experiments/capture_snapshot.py
"""

from __future__ import annotations

import sys
from pathlib import Path

from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import ensure_output_dir  # noqa: E402
from qrb.catalog import fetch_catalog  # noqa: E402
from qrb.snapshot import save_snapshot, snapshot_captured_at  # noqa: E402

load_dotenv()


def main() -> None:
    out_path = ensure_output_dir() / "shared_catalog_snapshot.json"
    print("Fetching live catalog (all providers, all devices)...")
    resources = fetch_catalog(live=True)
    print(f"Fetched {len(resources)} resources:")
    for r in sorted(resources, key=lambda r: (r.provider_id, r.resource_id)):
        print(f"  {r.provider_id}.{r.resource_id}\t{r.num_qubits}q\toperational={r.operational}")

    save_snapshot(resources, out_path)
    captured_at = snapshot_captured_at(out_path)
    print(f"\nWrote frozen snapshot to {out_path}")
    print(f"captured_at (UTC): {captured_at.isoformat()}")


if __name__ == "__main__":
    main()
