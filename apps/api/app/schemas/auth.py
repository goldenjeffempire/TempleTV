"""Request/response schemas for `/v1/auth` and `/v1/api-keys`."""

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator

from app.core.security import BCRYPT_MAX_PASSWORD_BYTES


class UserCreate(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8)
    full_name: str | None = None

    @field_validator("password")
    @classmethod
    def _password_fits_bcrypt(cls, value: str) -> str:
        if len(value.encode("utf-8")) > BCRYPT_MAX_PASSWORD_BYTES:
            raise ValueError(f"Password must be at most {BCRYPT_MAX_PASSWORD_BYTES} bytes.")
        return value


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    email: str
    full_name: str | None
    is_active: bool
    roles: list[str] = []


class TokenOut(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"


class RefreshRequest(BaseModel):
    refresh_token: str


class APIKeyCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)


class APIKeyCreatedOut(BaseModel):
    """Returned exactly once, at creation — the only time the plaintext key is visible."""

    id: uuid.UUID
    name: str
    api_key: str
    key_prefix: str
    created_at: datetime


class APIKeyOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    key_prefix: str
    last_used_at: datetime | None
    expires_at: datetime | None
    revoked_at: datetime | None
    created_at: datetime
