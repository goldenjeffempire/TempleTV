"""Async SQLAlchemy engine and session management.

No ORM models are defined yet — that's Milestone 2's domain schema. This
module exists now so that (a) the health check can prove DB connectivity,
and (b) Alembic has a real engine/metadata target to migrate against from
day one instead of being bolted on later.
"""

from collections.abc import AsyncGenerator

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from app.config import get_settings


class Base(DeclarativeBase):
    """Declarative base for all ORM models across the platform."""


_engine: AsyncEngine | None = None
_session_factory: async_sessionmaker[AsyncSession] | None = None


def get_engine() -> AsyncEngine:
    """Return a lazily-created, process-wide async engine."""
    global _engine
    if _engine is None:
        settings = get_settings()
        _engine = create_async_engine(
            settings.database_url,
            echo=settings.debug,
            pool_pre_ping=True,
        )
    return _engine


def get_session_factory() -> async_sessionmaker[AsyncSession]:
    """Return a lazily-created, process-wide session factory."""
    global _session_factory
    if _session_factory is None:
        _session_factory = async_sessionmaker(
            bind=get_engine(),
            class_=AsyncSession,
            expire_on_commit=False,
        )
    return _session_factory


async def get_db_session() -> AsyncGenerator[AsyncSession, None]:
    """FastAPI dependency yielding a request-scoped `AsyncSession`.

    Commits on clean completion, rolls back on any exception. Without this,
    `AsyncSession.close()` — called implicitly when the `async with` block
    below exits — discards any uncommitted work rather than persisting it;
    every write endpoint would appear to succeed within the request (reads
    in the same session see the flushed data) while never actually
    persisting anything. Centralizing commit here means repositories and
    endpoints can `flush()` freely without each one having to remember to
    commit — one less class of bug for every future write path to get wrong.
    """
    session_factory = get_session_factory()
    async with session_factory() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


async def check_database_connection() -> bool:
    """Ping the database. Used by the `/v1/health` endpoint's liveness check."""
    try:
        engine = get_engine()
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
        return True
    except Exception:
        return False
