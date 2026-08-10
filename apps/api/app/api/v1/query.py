"""`POST /v1/query` — free-text search over services.

Keyword (ILIKE) search for now, not semantic search — that's the
`services/search` (OpenSearch) and `services/ai` (pgvector) milestone. This
gives the endpoint real behavior today instead of a stub, and the contract
(`POST /v1/query` → list of services) won't need to change when the
implementation underneath gets smarter.
"""

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from app.api.deps import KnowledgeRepositoryDep
from app.config import get_settings
from app.schemas.envelope import Envelope, ResponseMetadata
from app.schemas.knowledge import ServiceSummaryOut

router = APIRouter(tags=["Query"])


class QueryRequest(BaseModel):
    query: str = Field(min_length=2, max_length=500)
    limit: int = Field(default=10, ge=1, le=50)


@router.post(
    "/query",
    response_model=Envelope[list[ServiceSummaryOut]],
    summary="Free-text search over services",
)
async def query_services(
    body: QueryRequest, request: Request, repo: KnowledgeRepositoryDep
) -> Envelope[list[ServiceSummaryOut]]:
    settings = get_settings()
    services = await repo.search_services(body.query, limit=body.limit)
    return Envelope(
        data=[ServiceSummaryOut.model_validate(s) for s in services],
        metadata=ResponseMetadata(version="v1", environment=settings.app_env),
        request_id=request.state.request_id,
    )
