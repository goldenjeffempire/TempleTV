"""`/v1/auth` — registration, login, token refresh, and the current-user endpoint."""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.exc import IntegrityError

from app.api.deps import AuthRepositoryDep, CurrentUserDep
from app.config import get_settings
from app.core.rate_limit import RateLimitExceeded, enforce_rate_limit
from app.core.security import (
    InvalidTokenError,
    TokenType,
    create_access_token,
    create_refresh_token,
    decode_token,
    hash_password,
    verify_password,
)
from app.db.models.auth import User
from app.schemas.auth import RefreshRequest, TokenOut, UserCreate, UserOut
from app.schemas.envelope import Envelope, ErrorDetail, ErrorEnvelope, ResponseMetadata

router = APIRouter(prefix="/auth", tags=["Auth"])

_LOGIN_RATE_LIMIT = 10
_LOGIN_RATE_LIMIT_WINDOW_SECONDS = 60

# Registration doesn't need to be as tight as login (no credential-guessing
# risk), but unrestricted account creation is still a real abuse vector —
# spam signups, email-bombing a victim address via the confirmation flow a
# future milestone might add, etc. A looser limit than login's is enough.
_REGISTER_RATE_LIMIT = 5
_REGISTER_RATE_LIMIT_WINDOW_SECONDS = 60


def _client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


async def _enforce_rate_limit_or_429(key: str, *, limit: int, window_seconds: int) -> None:
    """Shared translation from the core rate limiter's exception to an HTTP 429.

    Kept as one helper rather than duplicating this try/except in every
    rate-limited endpoint — `login` and `register` both use it today, and
    any future rate-limited endpoint (e.g. `POST /api-keys`) gets the same
    behavior for free.
    """
    try:
        await enforce_rate_limit(key, limit=limit, window_seconds=window_seconds)
    except RateLimitExceeded as exc:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=ErrorDetail(
                code="RATE_LIMITED", message="Too many attempts. Try again shortly."
            ).model_dump(),
        ) from exc


def _to_user_out(user: User) -> UserOut:
    return UserOut(
        id=user.id,
        email=user.email,
        full_name=user.full_name,
        is_active=user.is_active,
        roles=[r.name for r in user.roles],
    )


@router.post(
    "/register",
    response_model=Envelope[UserOut],
    status_code=status.HTTP_201_CREATED,
    responses={409: {"model": ErrorEnvelope}},
    summary="Register a new account",
)
async def register(
    body: UserCreate, request: Request, repo: AuthRepositoryDep
) -> Envelope[UserOut]:
    settings = get_settings()
    ip = _client_ip(request)

    await _enforce_rate_limit_or_429(
        f"register:{ip}", limit=_REGISTER_RATE_LIMIT, window_seconds=_REGISTER_RATE_LIMIT_WINDOW_SECONDS
    )

    if await repo.get_user_by_email(body.email) is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=ErrorDetail(
                code="EMAIL_ALREADY_REGISTERED", message="An account with this email already exists."
            ).model_dump(),
        )

    try:
        user = await repo.create_user(
            email=body.email,
            hashed_password=hash_password(body.password),
            full_name=body.full_name,
        )
    except IntegrityError as exc:
        # Defense in depth against the pre-check above: two concurrent
        # registrations for the same email can both pass "does this email
        # exist?" before either commits — the real guarantee is the DB's
        # unique constraint, this just keeps the race case's response
        # identical to the common case (clean 409) instead of a raw 500.
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=ErrorDetail(
                code="EMAIL_ALREADY_REGISTERED", message="An account with this email already exists."
            ).model_dump(),
        ) from exc

    default_role = await repo.get_default_role()
    if default_role is not None:
        user.roles = [default_role]

    await repo.record_audit_event(
        action="user.registered", user_id=user.id, ip_address=ip
    )

    return Envelope(
        data=_to_user_out(user),
        metadata=ResponseMetadata(version="v1", environment=settings.app_env),
        request_id=request.state.request_id,
    )


@router.post(
    "/login",
    response_model=Envelope[TokenOut],
    responses={401: {"model": ErrorEnvelope}, 429: {"model": ErrorEnvelope}},
    summary="Log in with email + password, receive access and refresh tokens",
)
async def login(
    request: Request,
    repo: AuthRepositoryDep,
    form_data: Annotated[OAuth2PasswordRequestForm, Depends()],
) -> Envelope[TokenOut]:
    settings = get_settings()
    ip = _client_ip(request)

    await _enforce_rate_limit_or_429(
        f"login:{ip}", limit=_LOGIN_RATE_LIMIT, window_seconds=_LOGIN_RATE_LIMIT_WINDOW_SECONDS
    )

    invalid_credentials = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=ErrorDetail(code="INVALID_CREDENTIALS", message="Incorrect email or password.").model_dump(),
        headers={"WWW-Authenticate": "Bearer"},
    )

    # `username` is OAuth2PasswordRequestForm's fixed field name — we treat
    # it as the account's email, per this platform's login model.
    user = await repo.get_user_by_email(form_data.username)
    if user is None or not verify_password(form_data.password, user.hashed_password):
        await repo.record_audit_event(
            action="auth.login_failed",
            user_id=user.id if user else None,
            ip_address=ip,
            metadata={"email": form_data.username},
        )
        raise invalid_credentials

    if not user.is_active:
        raise invalid_credentials

    await repo.record_audit_event(action="user.login", user_id=user.id, ip_address=ip)

    return Envelope(
        data=TokenOut(
            access_token=create_access_token(user.id),
            refresh_token=create_refresh_token(user.id),
        ),
        metadata=ResponseMetadata(version="v1", environment=settings.app_env),
        request_id=request.state.request_id,
    )


@router.post(
    "/refresh",
    response_model=Envelope[TokenOut],
    responses={401: {"model": ErrorEnvelope}},
    summary="Exchange a refresh token for a new access/refresh token pair",
)
async def refresh(
    body: RefreshRequest, request: Request, repo: AuthRepositoryDep
) -> Envelope[TokenOut]:
    settings = get_settings()
    invalid_token = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=ErrorDetail(code="INVALID_REFRESH_TOKEN", message="Refresh token is invalid or expired.").model_dump(),
        headers={"WWW-Authenticate": "Bearer"},
    )

    try:
        user_id = decode_token(body.refresh_token, expected_type=TokenType.REFRESH)
    except InvalidTokenError as exc:
        raise invalid_token from exc

    user = await repo.get_user_by_id(user_id)
    if user is None or not user.is_active:
        raise invalid_token

    return Envelope(
        # Refresh token is rotated (a new one issued each call) rather than
        # reused — limits how long a leaked refresh token stays useful.
        data=TokenOut(
            access_token=create_access_token(user.id),
            refresh_token=create_refresh_token(user.id),
        ),
        metadata=ResponseMetadata(version="v1", environment=settings.app_env),
        request_id=request.state.request_id,
    )


@router.get("/me", response_model=Envelope[UserOut], summary="Get the current authenticated user")
async def get_me(request: Request, current_user: CurrentUserDep) -> Envelope[UserOut]:
    settings = get_settings()
    return Envelope(
        data=_to_user_out(current_user),
        metadata=ResponseMetadata(version="v1", environment=settings.app_env),
        request_id=request.state.request_id,
    )
