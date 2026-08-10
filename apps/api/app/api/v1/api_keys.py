"""`/v1/api-keys` — programmatic access credentials, scoped to the authenticated user."""

import uuid

from fastapi import APIRouter, HTTPException, Request, status

from app.api.deps import AuthRepositoryDep, CurrentUserDep
from app.config import get_settings
from app.core.security import generate_api_key
from app.schemas.auth import APIKeyCreate, APIKeyCreatedOut, APIKeyOut
from app.schemas.envelope import Envelope, ErrorDetail, ErrorEnvelope, ResponseMetadata

router = APIRouter(prefix="/api-keys", tags=["API Keys"])


@router.post(
    "",
    response_model=Envelope[APIKeyCreatedOut],
    status_code=status.HTTP_201_CREATED,
    summary="Create a new API key (plaintext key is shown only in this response)",
)
async def create_api_key(
    body: APIKeyCreate,
    request: Request,
    current_user: CurrentUserDep,
    repo: AuthRepositoryDep,
) -> Envelope[APIKeyCreatedOut]:
    settings = get_settings()
    plaintext_key, key_prefix, hashed_key = generate_api_key()

    api_key = await repo.create_api_key(
        user_id=current_user.id, name=body.name, key_prefix=key_prefix, hashed_key=hashed_key
    )
    await repo.record_audit_event(
        action="api_key.created",
        user_id=current_user.id,
        entity_type="api_key",
        entity_id=api_key.id,
        ip_address=request.client.host if request.client else None,
    )

    return Envelope(
        data=APIKeyCreatedOut(
            id=api_key.id,
            name=api_key.name,
            api_key=plaintext_key,
            key_prefix=api_key.key_prefix,
            created_at=api_key.created_at,
        ),
        metadata=ResponseMetadata(version="v1", environment=settings.app_env),
        request_id=request.state.request_id,
    )


@router.get("", response_model=Envelope[list[APIKeyOut]], summary="List your API keys")
async def list_api_keys(
    request: Request, current_user: CurrentUserDep, repo: AuthRepositoryDep
) -> Envelope[list[APIKeyOut]]:
    settings = get_settings()
    keys = await repo.list_api_keys_for_user(current_user.id)
    return Envelope(
        data=[APIKeyOut.model_validate(k) for k in keys],
        metadata=ResponseMetadata(version="v1", environment=settings.app_env),
        request_id=request.state.request_id,
    )


@router.delete(
    "/{api_key_id}",
    response_model=Envelope[APIKeyOut],
    responses={404: {"model": ErrorEnvelope}},
    summary="Revoke an API key",
)
async def revoke_api_key(
    api_key_id: uuid.UUID,
    request: Request,
    current_user: CurrentUserDep,
    repo: AuthRepositoryDep,
) -> Envelope[APIKeyOut]:
    settings = get_settings()
    api_key = await repo.get_api_key(api_key_id, user_id=current_user.id)
    if api_key is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=ErrorDetail(
                code="API_KEY_NOT_FOUND", message="No API key found with that id."
            ).model_dump(),
        )

    await repo.revoke_api_key(api_key)
    await repo.record_audit_event(
        action="api_key.revoked",
        user_id=current_user.id,
        entity_type="api_key",
        entity_id=api_key.id,
        ip_address=request.client.host if request.client else None,
    )

    return Envelope(
        data=APIKeyOut.model_validate(api_key),
        metadata=ResponseMetadata(version="v1", environment=settings.app_env),
        request_id=request.state.request_id,
    )
