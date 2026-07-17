"""SQLAlchemy models for the two historical-data tables. Schema is managed
by Alembic (see migrations/) — these are the source of truth Alembic
autogenerate diffs against.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, Float, Integer, String
from sqlalchemy.dialects.postgresql import JSONB, TIMESTAMP
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class BindingLog(Base):
    """One row per qrb.select() call — the actual Binding produced, the
    Preferences that drove it, and the full candidate set considered (not
    just the winner), for research/evaluation analysis after the fact.
    """

    __tablename__ = "binding_log"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    created_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), index=True)
    source: Mapped[str] = mapped_column(String, index=True)
    """'cli' or 'api' — which entrypoint produced this binding."""
    task_id: Mapped[str] = mapped_column(String)
    preferences: Mapped[dict] = mapped_column(JSONB)
    """weights, max_cost, min_fidelity, max_queue, require_provider,
    require_operational, max_calibration_age_hours, pareto."""
    feasibility: Mapped[str] = mapped_column(String)
    engine_id: Mapped[str] = mapped_column(String)
    execution_time_ms: Mapped[float | None] = mapped_column(Float, nullable=True)
    solutions: Mapped[list] = mapped_column(JSONB)
    """The winning Solution(s): objective_value, binding, aggregated_features,
    violations — a list since Pareto mode returns several."""
    candidates: Mapped[list] = mapped_column(JSONB)
    """The full candidate set from Instance.candidates at solve time: id,
    provider_id, name, features — not just the winner."""


class CatalogTelemetry(Base):
    """One row per resource per poller tick — queue/status/calibration
    trend data, independent of any binding decision.
    """

    __tablename__ = "catalog_telemetry"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    sampled_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), index=True)
    resource_id: Mapped[str] = mapped_column(String, index=True)
    provider_id: Mapped[str] = mapped_column(String, index=True)
    vendor: Mapped[str] = mapped_column(String)
    num_qubits: Mapped[int] = mapped_column(Integer)
    queue_length: Mapped[int | None] = mapped_column(Integer, nullable=True)
    status: Mapped[str] = mapped_column(String)
    operational: Mapped[bool] = mapped_column(Boolean)
    last_calibrated_at: Mapped[datetime | None] = mapped_column(
        TIMESTAMP(timezone=True), nullable=True
    )
