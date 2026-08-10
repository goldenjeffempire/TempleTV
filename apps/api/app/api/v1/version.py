"""Version endpoint — reports build/version metadata."""

from fastapi import APIRouter, Request
from pydantic import BaseModel

from app.config import get_settings
from app.schemas.envelope import Envelope, ResponseMetadata

router = APIRouter(tags=["System"])


class VersionData(BaseModel):
    """Payload returned by the version endpoint."""

    name: str
    version: str
    api_version: str


@router.get("/version", response_model=Envelope[VersionData], summary="API version metadata")
async def get_version(request: Request) -> Envelope[VersionData]:
    """Return the running application name, semantic version, and API version."""
    settings = get_settings()

    return Envelope(
        data=VersionData(
            name=settings.app_name,
            version=settings.app_version,
            api_version="v1",
        ),
        metadata=ResponseMetadata(version="v1", environment=settings.app_env),
        request_id=request.state.request_id,
    )
