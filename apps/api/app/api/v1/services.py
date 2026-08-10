"""`/v1/services` — the platform's core knowledge payload.

`GET /v1/services/{slug}` is the answer to "how do I register a business":
requirements, fees, documents, and — for each of those — every
`Verification` recorded against it, so a client can see not just the
answer but how sure JKP is of it and where that came from.
"""

from fastapi import APIRouter, HTTPException, Request, status
from sqlalchemy.exc import IntegrityError

from app.api.deps import AuthRepositoryDep, KnowledgeRepositoryDep, require_permission
from app.config import get_settings
from app.db.models.auth import User
from app.db.models.geography import VerifiableEntityType, Verification
from app.db.models.knowledge import Service
from app.repositories.knowledge_repository import KnowledgeRepository
from app.schemas.envelope import Envelope, ErrorDetail, ErrorEnvelope, ResponseMetadata
from app.schemas.knowledge import (
    DocumentOut,
    FeeCreate,
    FeeOut,
    RequirementCreate,
    RequirementOut,
    ServiceCreate,
    ServiceDetailOut,
    ServiceSummaryOut,
    ServiceUpdate,
    VerificationOut,
)

KNOWLEDGE_WRITE_PERMISSION = "knowledge:write"

router = APIRouter(prefix="/services", tags=["Services"])


def _index_verifications_by_entity(
    verifications: list[Verification],
) -> dict[str, list[VerificationOut]]:
    """Group a flat verification list by `entity_id` for O(1) lookup during assembly."""
    grouped: dict[str, list[VerificationOut]] = {}
    for v in verifications:
        grouped.setdefault(str(v.entity_id), []).append(VerificationOut.model_validate(v))
    return grouped


async def _to_service_detail(
    service: Service, repo: KnowledgeRepository
) -> ServiceDetailOut:
    """Assemble the full detail payload, attaching verifications from a batch fetch.

    Requirements and fees don't carry an ORM `verifications` relationship —
    `Verification` uses a polymorphic (entity_type, entity_id) association
    with no real foreign key SQLAlchemy could traverse — so we fetch each
    batch explicitly and stitch it in here rather than relying on
    `from_attributes` to do it for us.
    """
    requirement_ids = [r.id for r in service.requirements]
    fee_ids = [f.id for f in service.fees]

    requirement_verifications = _index_verifications_by_entity(
        list(await repo.get_verifications_bulk(VerifiableEntityType.REQUIREMENT, requirement_ids))
    )
    fee_verifications = _index_verifications_by_entity(
        list(await repo.get_verifications_bulk(VerifiableEntityType.FEE, fee_ids))
    )

    requirements = [
        RequirementOut(
            id=r.id,
            name=r.name,
            description=r.description,
            is_mandatory=r.is_mandatory,
            sort_order=r.sort_order,
            verifications=requirement_verifications.get(str(r.id), []),
        )
        for r in service.requirements
    ]
    fees = [
        FeeOut(
            id=f.id,
            name=f.name,
            amount=float(f.amount),
            currency=f.currency,
            is_mandatory=f.is_mandatory,
            description=f.description,
            verifications=fee_verifications.get(str(f.id), []),
        )
        for f in service.fees
    ]
    documents = [
        DocumentOut(
            id=sd.document.id,
            name=sd.document.name,
            description=sd.document.description,
            is_mandatory=sd.is_mandatory,
            notes=sd.notes,
        )
        for sd in service.service_documents
    ]

    return ServiceDetailOut(
        id=service.id,
        name=service.name,
        slug=service.slug,
        category=service.category,
        description=service.description,
        typical_processing_time=service.typical_processing_time,
        version=service.version,
        agency=service.agency,
        law=service.law,
        requirements=requirements,
        fees=fees,
        documents=documents,
    )


@router.get("", response_model=Envelope[list[ServiceSummaryOut]], summary="List services")
async def list_services(
    request: Request,
    repo: KnowledgeRepositoryDep,
    category: str | None = None,
) -> Envelope[list[ServiceSummaryOut]]:
    """List services, optionally filtered by `category` (e.g. `business_registration`)."""
    settings = get_settings()
    services = await repo.list_services(category=category)
    return Envelope(
        data=[ServiceSummaryOut.model_validate(s) for s in services],
        metadata=ResponseMetadata(version="v1", environment=settings.app_env),
        request_id=request.state.request_id,
    )


@router.get(
    "/{slug}",
    response_model=Envelope[ServiceDetailOut],
    responses={404: {"model": ErrorEnvelope}},
    summary="Get full service detail — requirements, fees, documents, sources",
)
async def get_service(
    slug: str, request: Request, repo: KnowledgeRepositoryDep
) -> Envelope[ServiceDetailOut]:
    settings = get_settings()
    service = await repo.get_service_by_slug(slug)
    if service is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=ErrorDetail(
                code="SERVICE_NOT_FOUND", message=f"No service found with slug '{slug}'."
            ).model_dump(),
        )

    detail = await _to_service_detail(service, repo)
    return Envelope(
        data=detail,
        metadata=ResponseMetadata(version="v1", environment=settings.app_env),
        request_id=request.state.request_id,
    )


# --- Writes (Milestone 4) — all gated behind the `knowledge:write` permission ---


def _not_found(slug: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail=ErrorDetail(
            code="SERVICE_NOT_FOUND", message=f"No service found with slug '{slug}'."
        ).model_dump(),
    )


@router.post(
    "",
    response_model=Envelope[ServiceDetailOut],
    status_code=status.HTTP_201_CREATED,
    responses={404: {"model": ErrorEnvelope}, 409: {"model": ErrorEnvelope}},
    summary="Create a new service",
)
async def create_service(
    body: ServiceCreate,
    request: Request,
    repo: KnowledgeRepositoryDep,
    auth_repo: AuthRepositoryDep,
    current_user: User = require_permission(KNOWLEDGE_WRITE_PERMISSION),
) -> Envelope[ServiceDetailOut]:
    settings = get_settings()

    if await repo.get_agency(body.agency_id) is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=ErrorDetail(
                code="AGENCY_NOT_FOUND", message=f"No agency found with id '{body.agency_id}'."
            ).model_dump(),
        )
    if await repo.get_service_by_slug(body.slug) is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=ErrorDetail(
                code="SLUG_ALREADY_EXISTS", message=f"A service with slug '{body.slug}' already exists."
            ).model_dump(),
        )

    try:
        await repo.create_service(
            agency_id=body.agency_id,
            law_id=body.law_id,
            name=body.name,
            slug=body.slug,
            category=body.category,
            description=body.description,
            typical_processing_time=body.typical_processing_time,
        )
    except IntegrityError as exc:
        # Defense in depth against the pre-check above: two concurrent
        # requests for the same slug can both pass "does this slug exist?"
        # before either commits, so the real guarantee is the DB's unique
        # constraint, not the pre-check — this just makes the race case
        # return the same clean 409 as the common case instead of a raw 500.
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=ErrorDetail(
                code="SLUG_ALREADY_EXISTS", message=f"A service with slug '{body.slug}' already exists."
            ).model_dump(),
        ) from exc

    # Re-fetch through the fully-eager-loaded query rather than reusing the
    # object `create_service` returned — that object's `agency`/`law`
    # relationships were never loaded, and touching them here would trigger
    # an async lazy-load (MissingGreenlet). This also keeps the "load
    # everything a detail response needs" logic in one place instead of
    # duplicating it for the just-created case.
    service = await repo.get_service_by_slug(body.slug)
    if service is None:
        # Should be unreachable — we just created this row in the same
        # transaction. Not using `assert` for this: assertions are
        # stripped entirely when Python runs with `-O`, which would turn
        # this invariant into a silent `None` flowing into `service.id`
        # below (AttributeError) instead of a clear, deliberate error.
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=ErrorDetail(
                code="INTERNAL_ERROR",
                message="Service was created but could not be re-fetched.",
            ).model_dump(),
        )

    await auth_repo.record_audit_event(
        action="service.created",
        user_id=current_user.id,
        entity_type="service",
        entity_id=service.id,
    )

    detail = await _to_service_detail(service, repo)
    return Envelope(
        data=detail,
        metadata=ResponseMetadata(version="v1", environment=settings.app_env),
        request_id=request.state.request_id,
    )


@router.patch(
    "/{slug}",
    response_model=Envelope[ServiceDetailOut],
    responses={404: {"model": ErrorEnvelope}},
    summary="Update a service (partial — only fields present in the request are changed)",
)
async def update_service(
    slug: str,
    body: ServiceUpdate,
    request: Request,
    repo: KnowledgeRepositoryDep,
    auth_repo: AuthRepositoryDep,
    current_user: User = require_permission(KNOWLEDGE_WRITE_PERMISSION),
) -> Envelope[ServiceDetailOut]:
    settings = get_settings()
    service = await repo.get_service_by_slug(slug)
    if service is None:
        raise _not_found(slug)

    await repo.update_service(service, **body.model_dump(exclude_unset=True))
    await auth_repo.record_audit_event(
        action="service.updated",
        user_id=current_user.id,
        entity_type="service",
        entity_id=service.id,
        metadata=body.model_dump(exclude_unset=True),
    )

    detail = await _to_service_detail(service, repo)
    return Envelope(
        data=detail,
        metadata=ResponseMetadata(version="v1", environment=settings.app_env),
        request_id=request.state.request_id,
    )


@router.delete(
    "/{slug}",
    status_code=status.HTTP_204_NO_CONTENT,
    responses={404: {"model": ErrorEnvelope}},
    summary="Delete a service",
)
async def delete_service(
    slug: str,
    repo: KnowledgeRepositoryDep,
    auth_repo: AuthRepositoryDep,
    current_user: User = require_permission(KNOWLEDGE_WRITE_PERMISSION),
) -> None:
    service = await repo.get_service_by_slug(slug)
    if service is None:
        raise _not_found(slug)

    service_id = service.id
    await repo.delete_service(service)
    await auth_repo.record_audit_event(
        action="service.deleted", user_id=current_user.id, entity_type="service", entity_id=service_id
    )


@router.post(
    "/{slug}/requirements",
    response_model=Envelope[RequirementOut],
    status_code=status.HTTP_201_CREATED,
    responses={404: {"model": ErrorEnvelope}},
    summary="Add a requirement to a service",
)
async def add_requirement(
    slug: str,
    body: RequirementCreate,
    request: Request,
    repo: KnowledgeRepositoryDep,
    auth_repo: AuthRepositoryDep,
    current_user: User = require_permission(KNOWLEDGE_WRITE_PERMISSION),
) -> Envelope[RequirementOut]:
    settings = get_settings()
    service = await repo.get_service_by_slug(slug)
    if service is None:
        raise _not_found(slug)

    requirement = await repo.add_requirement(
        service_id=service.id,
        name=body.name,
        description=body.description,
        is_mandatory=body.is_mandatory,
        sort_order=body.sort_order,
    )
    await auth_repo.record_audit_event(
        action="requirement.created",
        user_id=current_user.id,
        entity_type="requirement",
        entity_id=requirement.id,
    )

    return Envelope(
        # Constructed explicitly, not via `.model_validate(requirement)` —
        # `RequirementOut.verifications` has no matching attribute on the
        # ORM `Requirement` (verifications are a polymorphic association,
        # not a real relationship — see the repository module docstring),
        # so `model_validate` with `from_attributes=True` would raise
        # trying to read it. A brand-new requirement has none yet anyway.
        data=RequirementOut(
            id=requirement.id,
            name=requirement.name,
            description=requirement.description,
            is_mandatory=requirement.is_mandatory,
            sort_order=requirement.sort_order,
            verifications=[],
        ),
        metadata=ResponseMetadata(version="v1", environment=settings.app_env),
        request_id=request.state.request_id,
    )


@router.post(
    "/{slug}/fees",
    response_model=Envelope[FeeOut],
    status_code=status.HTTP_201_CREATED,
    responses={404: {"model": ErrorEnvelope}},
    summary="Add a fee to a service",
)
async def add_fee(
    slug: str,
    body: FeeCreate,
    request: Request,
    repo: KnowledgeRepositoryDep,
    auth_repo: AuthRepositoryDep,
    current_user: User = require_permission(KNOWLEDGE_WRITE_PERMISSION),
) -> Envelope[FeeOut]:
    settings = get_settings()
    service = await repo.get_service_by_slug(slug)
    if service is None:
        raise _not_found(slug)

    fee = await repo.add_fee(
        service_id=service.id,
        name=body.name,
        amount=body.amount,
        currency=body.currency.upper(),
        is_mandatory=body.is_mandatory,
        description=body.description,
    )
    await auth_repo.record_audit_event(
        action="fee.created", user_id=current_user.id, entity_type="fee", entity_id=fee.id
    )

    return Envelope(
        data=FeeOut(
            id=fee.id,
            name=fee.name,
            amount=float(fee.amount),
            currency=fee.currency,
            is_mandatory=fee.is_mandatory,
            description=fee.description,
            verifications=[],
        ),
        metadata=ResponseMetadata(version="v1", environment=settings.app_env),
        request_id=request.state.request_id,
    )
