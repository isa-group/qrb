"""catalog_snapshot: complete catalogs fetched by the poller or on request

Revision ID: b3c1d2e4f5a6
Revises: 6d7aaf77392c
Create Date: 2026-11-04 18:00:00.000000

"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "b3c1d2e4f5a6"
down_revision: Union[str, None] = "6d7aaf77392c"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "catalog_snapshot",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("fetched_at", postgresql.TIMESTAMP(timezone=True), nullable=False),
        sa.Column("origin", sa.String(), nullable=False),
        sa.Column("providers", postgresql.ARRAY(sa.String()), nullable=False),
        sa.Column("resource_count", sa.Integer(), nullable=False),
        sa.Column("payload", sa.LargeBinary(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_catalog_snapshot_fetched_at"), "catalog_snapshot", ["fetched_at"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_catalog_snapshot_fetched_at"), table_name="catalog_snapshot")
    op.drop_table("catalog_snapshot")
