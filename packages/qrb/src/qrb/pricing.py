"""Maintained pricing constants. Provider pricing is not exposed on device
APIs, so it is tracked here and must be refreshed as providers change their
rate cards. Last verified: 2026-07-06.
"""

from __future__ import annotations

from qrb.providers.base import BraketPricing, IBMPricing

IBM_PAYGO_USD_PER_MINUTE = 96.0
IBM_PRICING = IBMPricing(rate_usd_per_second=IBM_PAYGO_USD_PER_MINUTE / 60.0)

IBM_PER_SUBJOB_OVERHEAD_S = 2.0
"""Fixed overhead per sub-job (payload load into control electronics)."""

IBM_QUICK_FORMULA_SLOPE = 0.00035
"""Fallback when the circuit cannot be scheduled: total_s ≈ 2 + 0.00035 * num_executions."""

# Amazon Braket QPU pricing (per-task + per-shot, USD). Keyed by hardware vendor.
BRAKET_QPU_PRICING: dict[str, BraketPricing] = {
    "AQT": BraketPricing(per_task_usd=0.30000, per_shot_usd=0.02350),
    "IonQ": BraketPricing(per_task_usd=0.30000, per_shot_usd=0.08000),
    "IQM": BraketPricing(per_task_usd=0.30000, per_shot_usd=0.00160),
    "Rigetti": BraketPricing(per_task_usd=0.30000, per_shot_usd=0.000425),
    "QuEra": BraketPricing(per_task_usd=0.30000, per_shot_usd=0.01000),
}
"""Note: IQM has two device families (Emerald $0.00160/shot, Garnet $0.00145/shot)
priced identically per-task; if both are onboarded, look up by device name instead
of vendor."""


def braket_pricing_for_vendor(vendor: str) -> BraketPricing:
    try:
        return BRAKET_QPU_PRICING[vendor]
    except KeyError as exc:
        raise ValueError(
            f"No maintained Braket pricing for vendor '{vendor}'. "
            f"Add it to BRAKET_QPU_PRICING in qrb.pricing."
        ) from exc
