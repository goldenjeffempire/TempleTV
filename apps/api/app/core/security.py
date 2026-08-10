"""Password hashing, JWT issuance/verification, and API key generation.

No secret ever touches the database in plaintext: passwords go through
bcrypt via passlib; API keys are generated once, hashed with SHA-256 for
storage, and the plaintext is returned to the caller exactly once (at
creation) and never persisted or logged.
"""

import hashlib
import secrets
import uuid
from datetime import UTC, datetime, timedelta
from enum import StrEnum
from typing import Any

from jose import JWTError, jwt
from passlib.context import CryptContext

from app.config import get_settings

_pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

# bcrypt silently truncates/errors past 72 bytes; enforce it explicitly at
# the boundary instead of letting bcrypt's behavior surprise us later.
BCRYPT_MAX_PASSWORD_BYTES = 72


class TokenType(StrEnum):
    ACCESS = "access"
    REFRESH = "refresh"


class InvalidTokenError(Exception):
    """Raised when a JWT is malformed, expired, or of the wrong type."""


def hash_password(plain_password: str) -> str:
    if len(plain_password.encode("utf-8")) > BCRYPT_MAX_PASSWORD_BYTES:
        raise ValueError(f"Password exceeds bcrypt's {BCRYPT_MAX_PASSWORD_BYTES}-byte limit.")
    return _pwd_context.hash(plain_password)


def verify_password(plain_password: str, hashed_password: str) -> bool:
    return _pwd_context.verify(plain_password, hashed_password)


def _create_token(subject: uuid.UUID, token_type: TokenType, expires_delta: timedelta) -> str:
    settings = get_settings()
    now = datetime.now(UTC)
    payload: dict[str, Any] = {
        "sub": str(subject),
        "type": token_type.value,
        "iat": now,
        "exp": now + expires_delta,
    }
    return jwt.encode(payload, settings.jwt_secret_key, algorithm=settings.jwt_algorithm)


def create_access_token(user_id: uuid.UUID) -> str:
    settings = get_settings()
    return _create_token(
        user_id, TokenType.ACCESS, timedelta(minutes=settings.jwt_access_token_expire_minutes)
    )


def create_refresh_token(user_id: uuid.UUID) -> str:
    settings = get_settings()
    return _create_token(
        user_id, TokenType.REFRESH, timedelta(days=settings.jwt_refresh_token_expire_days)
    )


def decode_token(token: str, *, expected_type: TokenType) -> uuid.UUID:
    """Decode and validate a JWT, returning the subject's user ID.

    Raises `InvalidTokenError` for anything wrong with the token —
    signature, expiry, malformed subject, or a token of the wrong type
    (e.g. a refresh token presented where an access token is required) —
    so callers have exactly one exception to handle rather than needing to
    separately catch `JWTError`, `KeyError`, and `ValueError`.
    """
    settings = get_settings()
    try:
        payload = jwt.decode(token, settings.jwt_secret_key, algorithms=[settings.jwt_algorithm])
    except JWTError as exc:
        raise InvalidTokenError("Token is invalid or expired.") from exc

    if payload.get("type") != expected_type.value:
        raise InvalidTokenError(f"Expected a {expected_type.value} token.")

    try:
        return uuid.UUID(payload["sub"])
    except (KeyError, ValueError) as exc:
        raise InvalidTokenError("Token subject is missing or malformed.") from exc


# --- API keys ---
#
# Format: `jkp_live_<32 url-safe random chars>`. The prefix makes leaked
# keys grep-able in logs/scanners (a common convention — GitHub, Stripe,
# etc. all do this), and lets us show a short, safe-to-display identifier
# in `GET /v1/api-keys` without ever re-displaying the full secret.

_API_KEY_PREFIX = "jkp_live_"


def generate_api_key() -> tuple[str, str, str]:
    """Generate a new API key.

    Returns `(plaintext_key, key_prefix, hashed_key)`. Only `key_prefix`
    and `hashed_key` should ever be persisted; `plaintext_key` is returned
    to the caller once and must never be stored or logged.
    """
    plaintext_key = f"{_API_KEY_PREFIX}{secrets.token_urlsafe(32)}"
    key_prefix = plaintext_key[:12]
    hashed_key = hash_api_key(plaintext_key)
    return plaintext_key, key_prefix, hashed_key


def hash_api_key(plaintext_key: str) -> str:
    """Hash an API key for storage/lookup.

    SHA-256, not bcrypt: API keys are already high-entropy random secrets
    (unlike user-chosen passwords), so we don't need bcrypt's deliberate
    slowness — and a fast, deterministic hash lets us look a key up by an
    indexed equality match instead of checking it against every stored
    hash on every request.
    """
    return hashlib.sha256(plaintext_key.encode("utf-8")).hexdigest()
