"""Data-access layer for the auth domain."""

import uuid
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.db.models.auth import APIKey, AuditLog, Role, User


class AuthRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def get_user_by_email(self, email: str) -> User | None:
        stmt = (
            select(User)
            .where(User.email == email)
            .options(selectinload(User.roles).selectinload(Role.permissions))
        )
        result = await self._session.execute(stmt)
        return result.scalar_one_or_none()

    async def get_user_by_id(self, user_id: uuid.UUID) -> User | None:
        stmt = (
            select(User)
            .where(User.id == user_id)
            .options(selectinload(User.roles).selectinload(Role.permissions))
        )
        result = await self._session.execute(stmt)
        return result.scalar_one_or_none()

    async def create_user(
        self, *, email: str, hashed_password: str, full_name: str | None
    ) -> User:
        user = User(email=email, hashed_password=hashed_password, full_name=full_name)
        self._session.add(user)
        await self._session.flush()
        user.roles = []  # populated relationship, avoids a lazy-load on first read
        return user

    async def get_default_role(self) -> Role | None:
        """The role assigned to newly registered users, if one has been seeded."""
        result = await self._session.execute(select(Role).where(Role.name == "member"))
        return result.scalar_one_or_none()

    async def create_api_key(
        self,
        *,
        user_id: uuid.UUID,
        name: str,
        key_prefix: str,
        hashed_key: str,
        expires_at: datetime | None = None,
    ) -> APIKey:
        api_key = APIKey(
            user_id=user_id,
            name=name,
            key_prefix=key_prefix,
            hashed_key=hashed_key,
            expires_at=expires_at,
        )
        self._session.add(api_key)
        await self._session.flush()
        return api_key

    async def get_api_key_by_hash(self, hashed_key: str) -> APIKey | None:
        stmt = (
            select(APIKey)
            .where(APIKey.hashed_key == hashed_key)
            .options(
                selectinload(APIKey.user)
                .selectinload(User.roles)
                .selectinload(Role.permissions)
            )
        )
        result = await self._session.execute(stmt)
        return result.scalar_one_or_none()

    async def list_api_keys_for_user(self, user_id: uuid.UUID) -> Sequence[APIKey]:
        stmt = (
            select(APIKey)
            .where(APIKey.user_id == user_id)
            .order_by(APIKey.created_at.desc())
        )
        result = await self._session.execute(stmt)
        return result.scalars().all()

    async def get_api_key(self, api_key_id: uuid.UUID, *, user_id: uuid.UUID) -> APIKey | None:
        """Fetch a key, scoped to its owner — callers must never be able to touch another user's key."""
        stmt = select(APIKey).where(APIKey.id == api_key_id, APIKey.user_id == user_id)
        result = await self._session.execute(stmt)
        return result.scalar_one_or_none()

    async def revoke_api_key(self, api_key: APIKey) -> None:
        api_key.revoked_at = datetime.now(UTC)
        await self._session.flush()

    async def touch_api_key_last_used(self, api_key: APIKey) -> None:
        api_key.last_used_at = datetime.now(UTC)
        await self._session.flush()

    async def record_audit_event(
        self,
        *,
        action: str,
        user_id: uuid.UUID | None = None,
        entity_type: str | None = None,
        entity_id: uuid.UUID | None = None,
        ip_address: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        self._session.add(
            AuditLog(
                user_id=user_id,
                action=action,
                entity_type=entity_type,
                entity_id=entity_id,
                ip_address=ip_address,
                audit_metadata=metadata,
            )
        )
        await self._session.flush()
