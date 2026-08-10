"""`GET /v1/knowledge` — coverage overview.

The entrypoint a new client hits first: what countries and categories does
JKP actually have data for, before drilling into `/v1/services`.
"""

from fastapi import APIRouter, Request

from app.api.deps import KnowledgeRepositoryDep
from app.config import get_settings
from app.schemas.envelope import Envelope, ResponseMetadata
from app.schemas.knowledge import CategoryCoverageOut, CountryCoverageOut

router = APIRouter(tags=["Knowledge"])


@router.get(
    "/knowledge",
    response_model=Envelope[list[CountryCoverageOut]],
    summary="Knowledge coverage overview, grouped by country and category",
)
async def get_knowledge_overview(
    request: Request, repo: KnowledgeRepositoryDep
) -> Envelope[list[CountryCoverageOut]]:
    settings = get_settings()
    rows = await repo.get_coverage_overview()

    by_country: dict[str, CountryCoverageOut] = {}
    for iso_code, name, category, service_count in rows:
        if iso_code not in by_country:
            by_country[iso_code] = CountryCoverageOut(
                country_iso_code=iso_code, country_name=name, categories=[]
            )
        by_country[iso_code].categories.append(
            CategoryCoverageOut(category=category, service_count=service_count)
        )

    return Envelope(
        data=list(by_country.values()),
        metadata=ResponseMetadata(version="v1", environment=settings.app_env),
        request_id=request.state.request_id,
    )
