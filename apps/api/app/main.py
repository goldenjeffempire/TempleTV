"""JOE Knowledge Platform — API application entrypoint.

Run locally with:
    uvicorn app.main:app --reload

Run via Docker Compose:
    docker compose up
"""

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest

from app.api.v1.router import api_v1_router
from app.config import get_settings
from app.core.exception_handlers import register_exception_handlers
from app.core.logging import configure_logging, get_logger
from app.core.middleware import MetricsMiddleware, RequestIDMiddleware, SecurityHeadersMiddleware

logger = get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """Application lifespan hook — startup and shutdown logic.

    Kept deliberately minimal in Milestone 1 (just logging + config
    validation). Connection pool warmup, cache clients, etc. get added here
    as those subsystems come online in later milestones.
    """
    settings = get_settings()
    configure_logging()
    logger.info(
        "Starting %s v%s in %s mode",
        settings.app_name,
        settings.app_version,
        settings.app_env,
    )
    yield
    logger.info("Shutting down %s", settings.app_name)


def create_app() -> FastAPI:
    """Application factory. Keeps app construction testable and import-safe."""
    settings = get_settings()

    app = FastAPI(
        title=settings.app_name,
        version=settings.app_version,
        description="Trusted digital intelligence infrastructure for Africa.",
        openapi_url=f"{settings.api_prefix}/openapi.json",
        docs_url=f"{settings.api_prefix}/docs",
        redoc_url=f"{settings.api_prefix}/redoc",
        lifespan=lifespan,
    )

    app.add_middleware(RequestIDMiddleware)
    app.add_middleware(MetricsMiddleware)
    app.add_middleware(SecurityHeadersMiddleware)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(api_v1_router, prefix=settings.api_prefix)
    register_exception_handlers(app)

    @app.get("/metrics", include_in_schema=False)
    async def metrics() -> Response:
        """Prometheus scrape target. Deliberately un-versioned and outside
        `/v1` — it's an infrastructure concern, not part of the public API
        surface, matching where every Prometheus setup expects to find it
        by default.
        """
        return Response(content=generate_latest(), media_type=CONTENT_TYPE_LATEST)

    return app


app = create_app()
