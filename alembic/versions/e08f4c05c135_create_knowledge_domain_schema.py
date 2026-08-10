"""create knowledge domain schema

Revision ID: e08f4c05c135
Revises:
Create Date: 2026-08-05 00:00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "e08f4c05c135"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

verification_status_enum = postgresql.ENUM(
    "verified", "unverified", "outdated", "disputed", name="verification_status"
)
verifiable_entity_type_enum = postgresql.ENUM(
    "agency", "office", "service", "requirement", "document", "fee",
    name="verifiable_entity_type",
)


def _timestamp_columns() -> list[sa.Column]:
    """`created_at` / `updated_at`, matching `app.db.models.mixins.TimestampMixin`."""
    return [
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    ]


def upgrade() -> None:
    bind = op.get_bind()
    verification_status_enum.create(bind, checkfirst=True)
    verifiable_entity_type_enum.create(bind, checkfirst=True)

    op.create_table(
        "countries",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("iso_code", sa.String(2), nullable=False),
        sa.Column("name", sa.String(100), nullable=False),
        *_timestamp_columns(),
        sa.UniqueConstraint("iso_code", name="uq_countries_iso_code"),
    )

    op.create_table(
        "states",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "country_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("countries.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("code", sa.String(10), nullable=True),
        *_timestamp_columns(),
        sa.UniqueConstraint("country_id", "name", name="uq_states_country_name"),
    )

    op.create_table(
        "sources",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("title", sa.String(255), nullable=False),
        sa.Column("url", sa.String(1000), nullable=False),
        sa.Column("publisher", sa.String(255), nullable=False),
        sa.Column("is_primary", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("accessed_at", sa.DateTime(timezone=True), nullable=False),
        *_timestamp_columns(),
    )

    op.create_table(
        "agencies",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "country_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("countries.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "state_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("states.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("short_name", sa.String(50), nullable=True),
        sa.Column("description", sa.Text, nullable=True),
        sa.Column("website", sa.String(500), nullable=True),
        sa.Column("phone", sa.String(50), nullable=True),
        sa.Column("email", sa.String(255), nullable=True),
        *_timestamp_columns(),
    )

    op.create_table(
        "offices",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "agency_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("agencies.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "state_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("states.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("address_line", sa.String(500), nullable=False),
        sa.Column("city", sa.String(100), nullable=True),
        sa.Column("phone", sa.String(50), nullable=True),
        sa.Column("email", sa.String(255), nullable=True),
        sa.Column("is_headquarters", sa.Boolean, nullable=False, server_default=sa.false()),
        *_timestamp_columns(),
    )

    op.create_table(
        "laws",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "country_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("countries.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("title", sa.String(500), nullable=False),
        sa.Column("short_title", sa.String(100), nullable=True),
        sa.Column("year_enacted", sa.Integer, nullable=True),
        sa.Column("url", sa.String(1000), nullable=True),
        *_timestamp_columns(),
    )

    op.create_table(
        "services",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "agency_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("agencies.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "law_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("laws.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("slug", sa.String(255), nullable=False),
        sa.Column("category", sa.String(100), nullable=False),
        sa.Column("description", sa.Text, nullable=False),
        sa.Column("typical_processing_time", sa.String(255), nullable=True),
        sa.Column("version", sa.Integer, nullable=False, server_default="1"),
        *_timestamp_columns(),
        sa.UniqueConstraint("slug", name="uq_services_slug"),
    )

    op.create_table(
        "requirements",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "service_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("services.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("description", sa.Text, nullable=True),
        sa.Column("is_mandatory", sa.Boolean, nullable=False, server_default=sa.true()),
        sa.Column("sort_order", sa.Integer, nullable=False, server_default="0"),
        *_timestamp_columns(),
    )

    op.create_table(
        "documents",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("description", sa.Text, nullable=True),
        *_timestamp_columns(),
        sa.UniqueConstraint("name", name="uq_documents_name"),
    )

    op.create_table(
        "service_documents",
        sa.Column(
            "service_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("services.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "document_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("documents.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("is_mandatory", sa.Boolean, nullable=False, server_default=sa.true()),
        sa.Column("notes", sa.Text, nullable=True),
        *_timestamp_columns(),
    )

    op.create_table(
        "fees",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "service_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("services.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("amount", sa.Numeric(12, 2), nullable=False),
        sa.Column("currency", sa.String(3), nullable=False),
        sa.Column("is_mandatory", sa.Boolean, nullable=False, server_default=sa.true()),
        sa.Column("description", sa.Text, nullable=True),
        *_timestamp_columns(),
    )

    op.create_table(
        "verifications",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("entity_type", verifiable_entity_type_enum, nullable=False),
        sa.Column("entity_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column(
            "source_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("sources.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("status", verification_status_enum, nullable=False),
        sa.Column("confidence_score", sa.Numeric(3, 2), nullable=False),
        sa.Column("verified_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("notes", sa.Text, nullable=True),
        *_timestamp_columns(),
    )
    op.create_index(
        "ix_verifications_entity", "verifications", ["entity_type", "entity_id"]
    )


def downgrade() -> None:
    op.drop_index("ix_verifications_entity", table_name="verifications")
    op.drop_table("verifications")
    op.drop_table("fees")
    op.drop_table("service_documents")
    op.drop_table("documents")
    op.drop_table("requirements")
    op.drop_table("services")
    op.drop_table("laws")
    op.drop_table("offices")
    op.drop_table("agencies")
    op.drop_table("sources")
    op.drop_table("states")
    op.drop_table("countries")

    bind = op.get_bind()
    verifiable_entity_type_enum.drop(bind, checkfirst=True)
    verification_status_enum.drop(bind, checkfirst=True)
