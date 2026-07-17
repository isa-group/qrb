"""Experiment 1 — Catalog Ingestion

How does the time to fetch catalog metadata (no circuit involved) scale
with catalog size, and does it differ between IBM Quantum and Amazon
Braket?

Usage: uv run python scripts/experiments/experiment1_ingestion.py [--pilot] [--reps N]
"""

from __future__ import annotations

import argparse
import sys
import time
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import (  # noqa: E402
    ensure_output_dir,
    nested_subsets,
    sorted_resource_ids,
    utc_timestamp,
    write_csv,
)
from qrb.catalog import fetch_catalog_timed  # noqa: E402

load_dotenv()

MIXED_SIZES = [2, 4, 6, 8, 10, 12]
SINGLE_PROVIDER_SIZES = [2, 4, 6]
REPS = 10
INTER_REP_DELAY_S = 1.5


@dataclass
class Config:
    provider_mix: str  # "mixed" | "ibm" | "braket"
    catalog_size: int
    providers: list[str]
    device_ids: list[str]


def build_configs(
    ibm_ids: list[str], braket_ids: list[str], mixed_sizes, single_sizes
) -> list[Config]:
    ibm_subsets = nested_subsets(ibm_ids, sorted({s // 2 for s in mixed_sizes} | set(single_sizes)))
    braket_subsets = nested_subsets(
        braket_ids, sorted({s // 2 for s in mixed_sizes} | set(single_sizes))
    )

    configs: list[Config] = []
    for size in mixed_sizes:
        half = size // 2
        configs.append(
            Config(
                provider_mix="mixed",
                catalog_size=size,
                providers=["ibm", "braket"],
                device_ids=[*ibm_subsets[half], *braket_subsets[half]],
            )
        )
    for size in single_sizes:
        configs.append(
            Config(
                provider_mix="ibm",
                catalog_size=size,
                providers=["ibm"],
                device_ids=list(ibm_subsets[size]),
            )
        )
    for size in single_sizes:
        configs.append(
            Config(
                provider_mix="braket",
                catalog_size=size,
                providers=["braket"],
                device_ids=list(braket_subsets[size]),
            )
        )
    return configs


def discover_device_ordering() -> tuple[list[str], list[str]]:
    """One untimed, unfiltered live fetch per provider — doubles as the
    warm-up that primes SDK auth/session cost outside any timed repetition,
    and as the source of the live device names the nested alphabetical
    subsets are built from."""
    print("Warm-up: discovering real IBM device names (untimed)...", flush=True)
    ibm_records, _, _ = fetch_catalog_timed(live=True, providers=["ibm"], force_refresh=True)
    print("Warm-up: discovering real Braket device names (untimed)...", flush=True)
    braket_records, _, _ = fetch_catalog_timed(live=True, providers=["braket"], force_refresh=True)

    ibm_ids = sorted_resource_ids(ibm_records)
    braket_ids = sorted_resource_ids(braket_records)
    print(f"  IBM ({len(ibm_ids)}): {ibm_ids}")
    print(f"  Braket ({len(braket_ids)}): {braket_ids}")
    return ibm_ids, braket_ids


def run(configs: list[Config], reps: int) -> list[dict]:
    rows = []
    total = len(configs) * reps
    n = 0
    for config in configs:
        resource_ids = frozenset(config.device_ids)
        for repetition in range(1, reps + 1):
            n += 1
            if repetition > 1 or config is not configs[0]:
                time.sleep(INTER_REP_DELAY_S)

            t0 = time.perf_counter()
            fetch_catalog_timed(
                live=True,
                providers=config.providers,
                resource_ids=resource_ids,
                force_refresh=True,
            )
            ingestion_ms = (time.perf_counter() - t0) * 1000

            print(
                f"[{n}/{total}] {config.provider_mix} size={config.catalog_size} "
                f"rep={repetition}: {ingestion_ms:.1f}ms",
                flush=True,
            )
            rows.append(
                {
                    "catalog_size": config.catalog_size,
                    "provider_mix": config.provider_mix,
                    "device_ids": ";".join(config.device_ids),
                    "repetition": repetition,
                    "ingestion_ms": round(ingestion_ms, 3),
                    "timestamp": utc_timestamp(),
                }
            )
    return rows


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--pilot",
        action="store_true",
        help="Tiny smoke-test sweep (mixed=2, ibm=2, braket=2, reps=2) instead of the full spec.",
    )
    parser.add_argument("--reps", type=int, default=None, help="Override repetitions per config.")
    parser.add_argument(
        "--out", default=None, help="Output CSV path (default: output/experiment1_ingestion.csv)"
    )
    args = parser.parse_args()

    if args.pilot:
        mixed_sizes, single_sizes, reps = [2], [2], (args.reps or 2)
    else:
        mixed_sizes, single_sizes, reps = MIXED_SIZES, SINGLE_PROVIDER_SIZES, (args.reps or REPS)

    ibm_ids, braket_ids = discover_device_ordering()
    configs = build_configs(ibm_ids, braket_ids, mixed_sizes, single_sizes)

    print(f"\nRunning {len(configs)} configs x {reps} reps = {len(configs) * reps} live fetches\n")
    rows = run(configs, reps)

    out_path = Path(args.out) if args.out else ensure_output_dir() / "experiment1_ingestion.csv"
    write_csv(
        out_path,
        ["catalog_size", "provider_mix", "device_ids", "repetition", "ingestion_ms", "timestamp"],
        rows,
    )
    print(f"\nWrote {len(rows)} rows to {out_path}")


if __name__ == "__main__":
    main()
