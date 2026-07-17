"""Periodic catalog telemetry sampler. Long-running loop: fetch the live
catalog every QRB_POLLER_INTERVAL_SECONDS and record one row per resource
into catalog_telemetry (packages/qrb-store) — independent of any binding
decision. No scheduler/cron needed; this process just sleeps between ticks.
"""

from __future__ import annotations

import logging
import os
import time

from dotenv import load_dotenv
from qrb.catalog import fetch_catalog
from qrb_store import record_telemetry_sample

load_dotenv()

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-5s %(message)s")
logger = logging.getLogger("qrb_poller")

DEFAULT_INTERVAL_SECONDS = 15 * 60


def _sample_once() -> None:
    resources = fetch_catalog(live=True)
    samples = [
        {
            "resource_id": r.resource_id,
            "provider_id": r.provider_id,
            "vendor": r.vendor,
            "num_qubits": r.num_qubits,
            "queue_length": r.queue_length,
            "status": r.status,
            "operational": r.operational,
            "last_calibrated_at": r.last_calibrated_at,
        }
        for r in resources
    ]
    record_telemetry_sample(samples)
    logger.info("Recorded telemetry for %d resources", len(samples))


def main() -> None:
    interval = float(os.environ.get("QRB_POLLER_INTERVAL_SECONDS", DEFAULT_INTERVAL_SECONDS))
    logger.info("Starting catalog telemetry poller (interval=%ss)", interval)
    while True:
        try:
            _sample_once()
        except Exception:
            logger.exception("Telemetry sample failed — will retry next interval.")
        time.sleep(interval)


if __name__ == "__main__":
    main()
