"""`GET /v1/search` — relevance-ranked full-text search over services.

Distinct from `POST /v1/query` (see that module and the repository's
`full_text_search` docstring for why both exist): this understands word
stemming and ranks results by relevance instead of returning arbitrary
substring matches.
"""

from fastapi import APIRouter, Query, Request

from app.api.deps import KnowledgeRepositoryDep
from app.config import get_settings
from app.schemas.envelope import Envelope, ResponseMetadata
from app.schemas.knowledge import ServiceSummaryOut

router = APIRouter(tags=["Search"])


@router.get(
    "/search",
    response_model=Envelope[list[ServiceSummaryOut]],
    summary="Relevance-ranked full-text search over services",
)
async def search(
    request: Request,
    repo: KnowledgeRepositoryDep,
    q: str = Query(min_length=2, max_length=500, description="Search text."),
    limit: int = Query(default=10, ge=1, le=50),
) -> Envelope[list[ServiceSummaryOut]]:
    settings = get_settings()
    services = await repo.full_text_search(q, limit=limit)
    return Envelope(
        data=[ServiceSummaryOut.model_validate(s) for s in services],
        metadata=ResponseMetadata(version="v1", environment=settings.app_env),
        request_id=request.state.request_id,
    )
