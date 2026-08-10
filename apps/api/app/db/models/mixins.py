"""Shared SQLAlchemy mixins used by every domain model.

Centralizing the primary-key and timestamp columns here means no model
redefines them — any future column added to `TimestampMixin` (e.g. a
soft-delete flag) lands on every entity at once.
"""

import uuid
from datetime import UTC, datetime

from sqlalchemy import DateTime
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column


class UUIDPrimaryKeyMixin:
    """Adds a UUID primary key, generated client-side.

    Generated in Python (not via a Postgres `DEFAULT gen_random_uuid()`) so
    the ID is available immediately after `flush()`, before a round-trip to
    the database, and so we have no dependency on the `pgcrypto` extension.
    """

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )


class TimestampMixin:
    """Adds `created_at` / `updated_at`, both timezone-aware UTC."""

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(UTC),
        onupdate=lambda: datetime.now(UTC),
        nullable=False,
    )


class CreatedAtMixin:
    """Adds `created_at` only — for immutable, append-only rows (e.g. audit logs).

    A separate mixin rather than reusing `TimestampMixin` and ignoring
    `updated_at`: an audit log row that *can* carry an `updated_at` column
    invites someone to eventually write an UPDATE against it, which quietly
    breaks the "audit logs are immutable" guarantee the whole table exists
    to provide.
    """

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC), nullable=False
    )
