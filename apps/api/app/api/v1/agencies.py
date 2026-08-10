"""`/v1/agencies` — which government bodies JKP has coverage for."""

import uuid

from fastapi import APIRouter, HTTPException, Request, status

from app.api.deps import KnowledgeRepositoryDep
from app.config import get_settings
from app.schemas.envelope import Envelope, ErrorDetail, ErrorEnvelope, ResponseMetadata
from app.schemas.knowledge import AgencyOut

router = APIRouter(prefix="/agencies", tags=["Agencies"])


@router.get("", response_model=Envelope[list[AgencyOut]], summary="List agencies")
async def list_agencies(
    request: Request,
    repo: KnowledgeRepositoryDep,
    country: str | None = None,
) -> Envelope[list[AgencyOut]]:
    """List agencies, optionally filtered by `country` (ISO 3166-1 alpha-2, e.g. `NG`)."""
    settings = get_settings()
    agencies = await repo.list_agencies(country_iso_code=country)
    return Envelope(
        data=[AgencyOut.model_validate(a) for a in agencies],
        metadata=ResponseMetadata(version="v1", environment=settings.app_env),
        request_id=request.state.request_id,
    )


@router.get(
    "/{agency_id}",
    response_model=Envelope[AgencyOut],
    responses={404: {"model": ErrorEnvelope}},
    summary="Get agency detail",
)
async def get_agency(
    agency_id: uuid.UUID, request: Request, repo: KnowledgeRepositoryDep
) -> Envelope[AgencyOut]:
    settings = get_settings()
    agency = await repo.get_agency(agency_id)
    if agency is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=ErrorDetail(
                code="AGENCY_NOT_FOUND", message=f"No agency found with id '{agency_id}'."
            ).model_dump(),
        )
    return Envelope(
        data=AgencyOut.model_validate(agency),
        metadata=ResponseMetadata(version="v1", environment=settings.app_env),
        request_id=request.state.request_id,
    )
