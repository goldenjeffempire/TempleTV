"""Import every model here so `Base.metadata` is complete.

Alembic's `env.py` imports `app.db.session.Base` and diffs `Base.metadata`
against the live database. If a model module is never imported anywhere,
its table silently never enters that metadata and autogenerate will never
see it. This module exists purely to force that import — prefer importing
from `app.db.models.<module>` directly in application code; this re-export
is for migration tooling and test setup.
"""

from app.db.models.auth import APIKey, AuditLog, Permission, Role, RolePermission, User, UserRole
from app.db.models.geography import Country, Source, State, Verification, VerificationStatus
from app.db.models.knowledge import (
    Agency,
    Document,
    Fee,
    Law,
    Office,
    Requirement,
    Service,
    ServiceDocument,
)

__all__ = [
    "Agency",
    "AuditLog",
    "APIKey",
    "Country",
    "Document",
    "Fee",
    "Law",
    "Office",
    "Permission",
    "Requirement",
    "Role",
    "RolePermission",
    "Service",
    "ServiceDocument",
    "Source",
    "State",
    "User",
    "UserRole",
    "Verification",
    "VerificationStatus",
]
