"""Alembic migration environment.

Wired to the same async engine/settings the application uses, so
`alembic revision --autogenerate` compares against `Base.metadata` — the
real source of truth — instead of a hand-maintained schema snapshot.
"""

import asyncio
import sys
from logging.config import fileConfig
from pathlib import Path

from alembic import context
from sqlalchemy import pool
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

# Make `app.*` importable when Alembic is invoked from the repo root.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "apps" / "api"))

from app.config import get_settings  # noqa: E402
from app.db.session import Base  # noqa: E402

# Import every model module so Base.metadata is fully populated before we
# diff against it — see app/db/models/__init__.py for why this is needed.
import app.db.models  # noqa: E402,F401

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata

settings = get_settings()
config.set_main_option("sqlalchemy.url", settings.database_url)


def run_migrations_offline() -> None:
    """Run migrations without a live DB connection, emitting SQL to stdout."""
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def do_run_migrations(connection) -> None:
    context.configure(connection=connection, target_metadata=target_metadata)
    with context.begin_transaction():
        context.run_migrations()


async def run_migrations_online() -> None:
    """Run migrations against a live async DB connection."""
    connectable: AsyncEngine = create_async_engine(
        config.get_main_option("sqlalchemy.url"),
        poolclass=pool.NullPool,
    )

    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)

    await connectable.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    asyncio.run(run_migrations_online())
