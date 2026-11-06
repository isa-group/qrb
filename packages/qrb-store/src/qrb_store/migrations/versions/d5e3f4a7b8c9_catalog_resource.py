"""catalog_resource: one row per QPU and calibration (replaces whole-catalog catalog_snapshot)

Revision ID: d5e3f4a7b8c9
Revises: c4d2e3f6a7b8
Create Date: 2026-11-04 22:00:00.000000

"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "d5e3f4a7b8c9"
down_revision: Union[str, None] = "c4d2e3f6a7b8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "catalog_resource",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("provider_id", sa.String(), nullable=False),
        sa.Column("resource_id", sa.String(), nullable=False),
        sa.Column("fetched_at", postgresql.TIMESTAMP(timezone=True), nullable=False),
        sa.Column("checked_at", postgresql.TIMESTAMP(timezone=True), nullable=False),
        sa.Column("calibrated_at", postgresql.TIMESTAMP(timezone=True), nullable=True),
        sa.Column("fingerprint", sa.String(), nullable=False),
        sa.Column("origin", sa.String(), nullable=False),
        sa.Column("payload", sa.LargeBinary(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_catalog_resource_latest", "catalog_resource", ["provider_id", "resource_id", "id"], unique=False)
    op.create_index(op.f("ix_catalog_resource_checked_at"), "catalog_resource", ["checked_at"], unique=False)
    # Whole-catalog rows (a few hours old when this shipped) are replaced by per-QPU rows.
    op.drop_index(op.f("ix_catalog_snapshot_fingerprint"), table_name="catalog_snapshot")
    op.drop_index(op.f("ix_catalog_snapshot_fetched_at"), table_name="catalog_snapshot")
    op.drop_table("catalog_snapshot")


def downgrade() -> None:
    op.create_table(
        "catalog_snapshot",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("fetched_at", postgresql.TIMESTAMP(timezone=True), nullable=False),
        sa.Column("origin", sa.String(), nullable=False),
        sa.Column("providers", postgresql.ARRAY(sa.String()), nullable=False),
        sa.Column("resource_count", sa.Integer(), nullable=False),
        sa.Column("payload", sa.LargeBinary(), nullable=False),
        sa.Column("fingerprint", sa.String(), nullable=True),
        sa.Column("checked_at", postgresql.TIMESTAMP(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_catalog_snapshot_fetched_at"), "catalog_snapshot", ["fetched_at"], unique=False)
    op.create_index(op.f("ix_catalog_snapshot_fingerprint"), "catalog_snapshot", ["fingerprint"], unique=False)
    op.drop_index(op.f("ix_catalog_resource_checked_at"), table_name="catalog_resource")
    op.drop_index("ix_catalog_resource_latest", table_name="catalog_resource")
    op.drop_table("catalog_resource")
