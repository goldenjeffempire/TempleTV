"""Data-access layer for the knowledge domain.

Endpoints depend on this repository (via FastAPI `Depends`), never on
SQLAlchemy directly. That's the whole payoff of the split: swapping how a
query is written, adding caching, or moving a read off to a replica later
only touches this file.
"""

import uuid
from collections.abc import Sequence

from sqlalchemy import func, select
from sqlalchemy.engine import Row
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.db.models.geography import Country, Verification, VerifiableEntityType
from app.db.models.knowledge import Agency, Fee, Requirement, Service, ServiceDocument


class KnowledgeRepository:
    """Data-access layer over the knowledge domain tables — reads and, since
    Milestone 4, the authenticated writes under `/v1/services`.
    """

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def list_agencies(
        self, *, country_iso_code: str | None = None
    ) -> Sequence[Agency]:
        stmt = select(Agency).options(selectinload(Agency.offices), selectinload(Agency.country))
        if country_iso_code:
            stmt = stmt.where(Agency.country.has(iso_code=country_iso_code.upper()))
        result = await self._session.execute(stmt)
        return result.scalars().unique().all()

    async def get_agency(self, agency_id: uuid.UUID) -> Agency | None:
        stmt = (
            select(Agency)
            .where(Agency.id == agency_id)
            .options(selectinload(Agency.offices), selectinload(Agency.services))
        )
        result = await self._session.execute(stmt)
        return result.scalar_one_or_none()

    async def list_services(
        self, *, category: str | None = None, agency_id: uuid.UUID | None = None
    ) -> Sequence[Service]:
        stmt = select(Service).options(selectinload(Service.agency))
        if category:
            stmt = stmt.where(Service.category == category)
        if agency_id:
            stmt = stmt.where(Service.agency_id == agency_id)
        result = await self._session.execute(stmt)
        return result.scalars().unique().all()

    async def get_service_by_slug(self, slug: str) -> Service | None:
        """Fetch a service with every relation an answer to "how do I..." needs."""
        stmt = (
            select(Service)
            .where(Service.slug == slug)
            .options(
                selectinload(Service.agency).selectinload(Agency.offices),
                selectinload(Service.law),
                selectinload(Service.requirements),
                selectinload(Service.fees),
                selectinload(Service.service_documents).selectinload(ServiceDocument.document),
            )
        )
        result = await self._session.execute(stmt)
        return result.scalar_one_or_none()

    async def search_services(self, query: str, *, limit: int = 10) -> Sequence[Service]:
        """Simple ILIKE search over name/description/category.

        This is intentionally not semantic search — that's the `services/ai`
        + `services/search` (OpenSearch/pgvector) milestone. For now it gives
        `POST /v1/query` something real to run against rather than a stub.
        """
        pattern = f"%{query}%"
        stmt = (
            select(Service)
            .where(
                Service.name.ilike(pattern)
                | Service.description.ilike(pattern)
                | Service.category.ilike(pattern)
            )
            .options(selectinload(Service.agency))
            .limit(limit)
        )
        result = await self._session.execute(stmt)
        return result.scalars().unique().all()

    async def full_text_search(self, query: str, *, limit: int = 10) -> Sequence[Service]:
        """Relevance-ranked full-text search over `Service.search_vector`.

        Distinct from `search_services` (plain ILIKE substring matching):
        this understands word stemming ("register" matches "registration"),
        ranks results by relevance via `ts_rank` instead of returning
        matches in arbitrary order, and supports `websearch_to_tsquery`'s
        natural search-engine-style syntax (quoted phrases, `-exclude`,
        implicit AND between terms) — genuinely different behavior, not
        just a fancier implementation of the same feature, which is why
        both `POST /v1/query` and `GET /v1/search` exist side by side
        rather than one replacing the other.
        """
        tsquery = func.websearch_to_tsquery("english", query)
        rank = func.ts_rank(Service.search_vector, tsquery).label("rank")
        stmt = (
            select(Service)
            .where(Service.search_vector.op("@@")(tsquery))
            .options(selectinload(Service.agency))
            .order_by(rank.desc())
            .limit(limit)
        )
        result = await self._session.execute(stmt)
        return result.scalars().unique().all()

    async def get_verifications_for(
        self, entity_type: VerifiableEntityType, entity_id: uuid.UUID
    ) -> Sequence[Verification]:
        stmt = (
            select(Verification)
            .where(Verification.entity_type == entity_type, Verification.entity_id == entity_id)
            .options(selectinload(Verification.source))
        )
        result = await self._session.execute(stmt)
        return result.scalars().all()

    async def get_coverage_overview(self) -> Sequence[Row]:
        """Aggregate coverage: how many services JKP has per country per category.

        Powers `GET /v1/knowledge` — a client's first call to discover what
        JKP actually covers before drilling into `/v1/services`.
        """
        stmt = (
            select(
                Country.iso_code,
                Country.name,
                Service.category,
                func.count(Service.id).label("service_count"),
            )
            .select_from(Service)
            .join(Agency, Service.agency_id == Agency.id)
            .join(Country, Agency.country_id == Country.id)
            .group_by(Country.iso_code, Country.name, Service.category)
            .order_by(Country.name, Service.category)
        )
        result = await self._session.execute(stmt)
        return result.all()

    async def get_verifications_bulk(
        self, entity_type: VerifiableEntityType, entity_ids: Sequence[uuid.UUID]
    ) -> Sequence[Verification]:
        """Batch-fetch verifications for many entities of the same type at once.

        Used when rendering a list (e.g. all requirements for a service) so
        we issue one query instead of N — avoids the classic N+1 that a
        naive per-item `get_verifications_for` call in a loop would cause.
        """
        if not entity_ids:
            return []
        stmt = (
            select(Verification)
            .where(Verification.entity_type == entity_type, Verification.entity_id.in_(entity_ids))
            .options(selectinload(Verification.source))
        )
        result = await self._session.execute(stmt)
        return result.scalars().all()

    # --- Writes (Milestone 4) ---

    async def create_service(
        self,
        *,
        agency_id: uuid.UUID,
        law_id: uuid.UUID | None,
        name: str,
        slug: str,
        category: str,
        description: str,
        typical_processing_time: str | None,
    ) -> Service:
        service = Service(
            agency_id=agency_id,
            law_id=law_id,
            name=name,
            slug=slug,
            category=category,
            description=description,
            typical_processing_time=typical_processing_time,
        )
        self._session.add(service)
        await self._session.flush()
        # Freshly created — these collections are genuinely empty, not just
        # unloaded. Setting them explicitly avoids a lazy-load the first
        # time a caller reads `service.requirements` etc. within this
        # request (e.g. when the create endpoint builds its response).
        service.requirements = []
        service.fees = []
        service.service_documents = []
        return service

    async def update_service(self, service: Service, **fields: object) -> Service:
        """Apply `fields` to `service` and bump its version if anything actually changed.

        `**fields` is expected to come from `ServiceUpdate.model_dump(exclude_unset=True)`
        — i.e. already filtered to just the fields the caller actually sent.
        """
        changed = False
        for field_name, value in fields.items():
            if getattr(service, field_name) != value:
                setattr(service, field_name, value)
                changed = True
        if changed:
            service.version += 1
        await self._session.flush()
        return service

    async def delete_service(self, service: Service) -> None:
        await self._session.delete(service)
        await self._session.flush()

    async def add_requirement(
        self,
        *,
        service_id: uuid.UUID,
        name: str,
        description: str | None,
        is_mandatory: bool,
        sort_order: int,
    ) -> Requirement:
        requirement = Requirement(
            service_id=service_id,
            name=name,
            description=description,
            is_mandatory=is_mandatory,
            sort_order=sort_order,
        )
        self._session.add(requirement)
        await self._session.flush()
        return requirement

    async def add_fee(
        self,
        *,
        service_id: uuid.UUID,
        name: str,
        amount: float,
        currency: str,
        is_mandatory: bool,
        description: str | None,
    ) -> Fee:
        fee = Fee(
            service_id=service_id,
            name=name,
            amount=amount,
            currency=currency,
            is_mandatory=is_mandatory,
            description=description,
        )
        self._session.add(fee)
        await self._session.flush()
        return fee
