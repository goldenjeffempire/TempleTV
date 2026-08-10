"""add full-text search vector to services

Revision ID: 1f6fd43bfe41
Revises: b7d2e81e00a8
Create Date: 2026-08-07 00:00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import TSVECTOR

# revision identifiers, used by Alembic.
revision: str = "1f6fd43bfe41"
down_revision: str | None = "b7d2e81e00a8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_SEARCH_VECTOR_EXPRESSION = (
    "setweight(to_tsvector('english', coalesce(name, '')), 'A') || "
    "setweight(to_tsvector('english', coalesce(category, '')), 'B') || "
    "setweight(to_tsvector('english', coalesce(description, '')), 'C')"
)


def upgrade() -> None:
    # A `GENERATED ALWAYS AS ... STORED` column — Postgres recomputes and
    # persists it on every INSERT/UPDATE to `name`/`category`/`description`
    # automatically. No trigger, no app-level code has to remember to keep
    # it in sync; see `Service.search_vector` in the model for the mirrored
    # (and authoritative) definition.
    op.add_column(
        "services",
        sa.Column(
            "search_vector",
            TSVECTOR,
            sa.Computed(_SEARCH_VECTOR_EXPRESSION, persisted=True),
            nullable=True,
        ),
    )
    op.create_index(
        "ix_services_search_vector", "services", ["search_vector"], postgresql_using="gin"
    )


def downgrade() -> None:
    op.drop_index("ix_services_search_vector", table_name="services")
    op.drop_column("services", "search_vector")
