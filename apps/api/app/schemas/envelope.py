"""Standard response envelope.

Every JKP API response — success or error — is wrapped in this shape so
that SDK clients (sdk-python, sdk-js) can rely on a single, predictable
contract instead of parsing bespoke shapes per-endpoint.
"""

from datetime import UTC, datetime
from typing import Generic, TypeVar

from pydantic import BaseModel, Field

T = TypeVar("T")


class ResponseMetadata(BaseModel):
    """Non-payload information about how the response was produced."""

    version: str = Field(description="API version that served this response, e.g. 'v1'.")
    environment: str = Field(description="Deployment environment that served this response.")


class Envelope(BaseModel, Generic[T]):
    """Generic success envelope wrapping a typed `data` payload."""

    success: bool = True
    data: T
    metadata: ResponseMetadata
    timestamp: datetime = Field(default_factory=lambda: datetime.now(UTC))
    request_id: str


class ErrorDetail(BaseModel):
    """Structured error body, distinct from a successful payload."""

    code: str = Field(description="Machine-readable error code, e.g. 'NOT_FOUND'.")
    message: str = Field(description="Human-readable explanation of the error.")


class ErrorEnvelope(BaseModel):
    """Generic error envelope. Mirrors `Envelope` but carries `error` instead of `data`."""

    success: bool = False
    error: ErrorDetail
    metadata: ResponseMetadata
    timestamp: datetime = Field(default_factory=lambda: datetime.now(UTC))
    request_id: str
