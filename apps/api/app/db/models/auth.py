"""Auth domain models.

RBAC via `Role`/`Permission` (many-to-many both to each other and to
`User`), plus `APIKey` for programmatic access and `AuditLog` for
security-relevant events. No password or key material is ever stored in
plaintext — see `app/core/security.py` for hashing.
"""

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import Boolean, DateTime, ForeignKey, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.models.mixins import CreatedAtMixin, TimestampMixin, UUIDPrimaryKeyMixin
from app.db.session import Base


class Permission(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A single grantable capability, e.g. `knowledge:write`."""

    __tablename__ = "permissions"

    code: Mapped[str] = mapped_column(String(100), nullable=False, unique=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)


class Role(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A named bundle of permissions, e.g. `editor`, `admin`."""

    __tablename__ = "roles"

    name: Mapped[str] = mapped_column(String(50), nullable=False, unique=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)

    permissions: Mapped[list["Permission"]] = relationship(secondary="role_permissions")


class RolePermission(TimestampMixin, Base):
    """Association: which permissions a role grants."""

    __tablename__ = "role_permissions"

    role_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("roles.id", ondelete="CASCADE"), primary_key=True
    )
    permission_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("permissions.id", ondelete="CASCADE"), primary_key=True
    )


class User(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A platform account. Authenticates via password (JWT) or an `APIKey`."""

    __tablename__ = "users"

    email: Mapped[str] = mapped_column(String(255), nullable=False, unique=True)
    hashed_password: Mapped[str] = mapped_column(String(255), nullable=False)
    full_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    is_superuser: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    roles: Mapped[list["Role"]] = relationship(secondary="user_roles")
    api_keys: Mapped[list["APIKey"]] = relationship(back_populates="user", passive_deletes=True)


class UserRole(TimestampMixin, Base):
    """Association: which roles a user holds."""

    __tablename__ = "user_roles"

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    role_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("roles.id", ondelete="CASCADE"), primary_key=True
    )


class APIKey(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A long-lived credential for programmatic (non-browser) API access.

    Only a hash of the key is ever persisted (`hashed_key`) — the plaintext
    key is generated once, returned to the caller at creation time, and
    never stored or shown again. `key_prefix` (the first few characters) is
    kept in the clear purely so a user can recognize *which* key is which
    in a list without the full secret being visible anywhere but the
    original creation response.
    """

    __tablename__ = "api_keys"

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    key_prefix: Mapped[str] = mapped_column(String(12), nullable=False)
    hashed_key: Mapped[str] = mapped_column(String(255), nullable=False, unique=True)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    user: Mapped["User"] = relationship(back_populates="api_keys")


class AuditLog(UUIDPrimaryKeyMixin, CreatedAtMixin, Base):
    """An immutable record of a security-relevant event.

    `user_id` is nullable — a failed login attempt for an email that
    doesn't exist has no user to attribute it to, but is exactly the kind
    of event this table exists to capture.
    """

    __tablename__ = "audit_logs"

    user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    action: Mapped[str] = mapped_column(
        String(100), nullable=False, doc="e.g. 'user.login', 'api_key.created'."
    )
    entity_type: Mapped[str | None] = mapped_column(String(50), nullable=True)
    entity_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    ip_address: Mapped[str | None] = mapped_column(String(45), nullable=True)
    audit_metadata: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
