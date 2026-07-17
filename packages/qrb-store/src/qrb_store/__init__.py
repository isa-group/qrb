"""Postgres persistence for QRB's historical data. Deliberately outside
`qrb` itself (ADR-style separation: the core library is pure/DB-free,
selection works with zero Postgres configured — see CONTEXT.md). Apps call
record_binding()/record_telemetry_sample() explicitly after their own
select()/fetch_catalog() calls.

No DATABASE_URL configured means these are no-ops (logged once), not errors —
persistence is optional, matching how IBM/AWS credentials are optional.
"""

from __future__ import annotations

from qrb_store.repository import record_binding, record_telemetry_sample

__all__ = ["record_binding", "record_telemetry_sample"]
