"""catalog_status (queues every few minutes) and catalog_snapshot fingerprint/checked_at

Revision ID: c4d2e3f6a7b8
Revises: b3c1d2e4f5a6
Create Date: 2026-11-04 21:00:00.000000

"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "c4d2e3f6a7b8"
down_revision: Union[str, None] = "b3c1d2e4f5a6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("catalog_snapshot", sa.Column("fingerprint", sa.String(), nullable=True))
    op.add_column("catalog_snapshot", sa.Column("checked_at", postgresql.TIMESTAMP(timezone=True), nullable=True))
    op.execute("UPDATE catalog_snapshot SET checked_at = fetched_at")
    op.create_index(op.f("ix_catalog_snapshot_fingerprint"), "catalog_snapshot", ["fingerprint"], unique=False)
    op.create_table(
        "catalog_status",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("fetched_at", postgresql.TIMESTAMP(timezone=True), nullable=False),
        sa.Column("origin", sa.String(), nullable=False),
        sa.Column("statuses", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_catalog_status_fetched_at"), "catalog_status", ["fetched_at"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_catalog_status_fetched_at"), table_name="catalog_status")
    op.drop_table("catalog_status")
    op.drop_index(op.f("ix_catalog_snapshot_fingerprint"), table_name="catalog_snapshot")
    op.drop_column("catalog_snapshot", "checked_at")
    op.drop_column("catalog_snapshot", "fingerprint")
