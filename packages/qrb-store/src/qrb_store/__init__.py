"""Postgres persistence for QRB's data. Deliberately outside `qrb` itself (the core library is
pure and DB-free; selection works with zero Postgres configured). Apps call these functions
explicitly: record_binding() after a solve, the poller's catalog writes, the API's catalog reads.

No DATABASE_URL configured means writes are no-ops (logged once), not errors: persistence is
optional, matching how IBM/AWS credentials are optional.
"""

from __future__ import annotations

from qrb_store.db import is_configured
from qrb_store.repository import (
    CatalogResourceMeta,
    CatalogStatus,
    latest_catalog_resources_meta,
    latest_catalog_status,
    load_catalog_resources,
    prune_catalog,
    record_binding,
    record_catalog_resources,
    record_catalog_status,
    record_telemetry_sample,
)

__all__ = [
    "CatalogResourceMeta",
    "CatalogStatus",
    "is_configured",
    "latest_catalog_resources_meta",
    "latest_catalog_status",
    "load_catalog_resources",
    "prune_catalog",
    "record_binding",
    "record_catalog_resources",
    "record_catalog_status",
    "record_telemetry_sample",
]
