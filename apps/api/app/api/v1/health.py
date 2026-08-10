"""Health check endpoints.

`/v1/health` is used by orchestrators (Docker healthcheck, k8s liveness/
readiness probes, load balancers) to determine whether this instance is
safe to receive traffic.
"""

from typing import Literal

from fastapi import APIRouter, Request
from pydantic import BaseModel

from app.config import get_settings
from app.db.session import check_database_connection
from app.schemas.envelope import Envelope, ResponseMetadata

router = APIRouter(tags=["System"])


class DependencyStatus(BaseModel):
    """Status of a single upstream dependency."""

    name: str
    status: Literal["up", "down"]


class HealthData(BaseModel):
    """Payload returned by the health check."""

    status: Literal["healthy", "degraded"]
    dependencies: list[DependencyStatus]


@router.get("/health", response_model=Envelope[HealthData], summary="Liveness and readiness check")
async def get_health(request: Request) -> Envelope[HealthData]:
    """Report service health, including the status of the database dependency.

    Returns `healthy` only when every checked dependency is reachable;
    otherwise `degraded`. This endpoint intentionally never raises — a
    failing dependency is reported in the payload, not as an HTTP error,
    so orchestrators get a clear machine-readable signal either way.
    """
    settings = get_settings()

    db_up = await check_database_connection()
    dependencies = [DependencyStatus(name="postgresql", status="up" if db_up else "down")]
    overall_status: Literal["healthy", "degraded"] = "healthy" if db_up else "degraded"

    return Envelope(
        data=HealthData(status=overall_status, dependencies=dependencies),
        metadata=ResponseMetadata(version="v1", environment=settings.app_env),
        request_id=request.state.request_id,
    )
