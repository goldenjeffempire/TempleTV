"""Reusable FastAPI dependencies for the knowledge-domain and auth-domain endpoints."""

from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import Depends, Header, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import InvalidTokenError, TokenType, decode_token, hash_api_key
from app.db.models.auth import User
from app.db.session import get_db_session
from app.repositories.auth_repository import AuthRepository
from app.repositories.knowledge_repository import KnowledgeRepository
from app.schemas.envelope import ErrorDetail


async def get_knowledge_repository(
    session: Annotated[AsyncSession, Depends(get_db_session)],
) -> KnowledgeRepository:
    return KnowledgeRepository(session)


KnowledgeRepositoryDep = Annotated[KnowledgeRepository, Depends(get_knowledge_repository)]

# `auto_error=False`: a missing/absent bearer token should fall through to
# the API-key check in `get_current_user` below, not immediately 401 —
# only raise once *neither* credential type is present.
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="v1/auth/login", auto_error=False)

BearerTokenDep = Annotated[str | None, Depends(oauth2_scheme)]
# `default=None` lives on the Header() metadata itself (not as a Python
# `= None` on the parameter) — see get_current_user below for why that
# matters: it lets every parameter there stay "no Python-level default",
# which sidesteps Python's "non-default argument follows default argument"
# rule entirely, regardless of what order the parameters are declared in.
ApiKeyHeaderDep = Annotated[str | None, Header(alias="X-API-Key", default=None)]


async def get_auth_repository(
    session: Annotated[AsyncSession, Depends(get_db_session)],
) -> AuthRepository:
    return AuthRepository(session)


AuthRepositoryDep = Annotated[AuthRepository, Depends(get_auth_repository)]


def _not_authenticated() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=ErrorDetail(
            code="NOT_AUTHENTICATED", message="A valid bearer token or API key is required."
        ).model_dump(),
        headers={"WWW-Authenticate": "Bearer"},
    )


async def get_current_user(
    token: BearerTokenDep,
    x_api_key: ApiKeyHeaderDep,
    repo: AuthRepositoryDep,
) -> User:
    """Resolve the authenticated user from either a JWT bearer token or an API key.

    Bearer token is checked first; if absent, falls back to `X-API-Key`.
    Both paths converge on the same `User` so route handlers never need to
    know or care which credential type was actually used.
    """
    if token is not None:
        try:
            user_id = decode_token(token, expected_type=TokenType.ACCESS)
        except InvalidTokenError as exc:
            raise _not_authenticated() from exc
        user = await repo.get_user_by_id(user_id)
        if user is None or not user.is_active:
            raise _not_authenticated()
        return user

    if x_api_key is not None:
        api_key = await repo.get_api_key_by_hash(hash_api_key(x_api_key))
        if api_key is None or api_key.revoked_at is not None:
            raise _not_authenticated()
        if api_key.expires_at is not None and api_key.expires_at < datetime.now(UTC):
            raise _not_authenticated()
        if not api_key.user.is_active:
            raise _not_authenticated()
        await repo.touch_api_key_last_used(api_key)
        return api_key.user

    raise _not_authenticated()


CurrentUserDep = Annotated[User, Depends(get_current_user)]


def require_permission(permission_code: str) -> Any:
    """Dependency factory: 403s unless the current user holds `permission_code`.

    Superusers bypass the check entirely — a superuser who has to be
    explicitly granted every individual permission isn't really a
    superuser, and RBAC systems that pretend otherwise tend to accumulate
    dozens of near-duplicate "admin-but-not-quite" permission grants over
    time to compensate.
    """

    async def _check(user: CurrentUserDep) -> User:
        if user.is_superuser:
            return user
        held_codes = {p.code for role in user.roles for p in role.permissions}
        if permission_code not in held_codes:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=ErrorDetail(
                    code="PERMISSION_DENIED",
                    message=f"This action requires the '{permission_code}' permission.",
                ).model_dump(),
            )
        return user

    return Depends(_check)
