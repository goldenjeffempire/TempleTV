"""Exception handlers.

Without these, a raised `HTTPException` falls through to Starlette's
default `{"detail": ...}` body — breaking the documented contract that
*every* response, success or error, is wrapped in the standard envelope.
This registers handlers that convert both `HTTPException` and unexpected
exceptions into `ErrorEnvelope`.
"""

from fastapi import FastAPI, HTTPException, Request, status
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from app.config import get_settings
from app.core.logging import get_logger
from app.schemas.envelope import ErrorDetail, ErrorEnvelope, ResponseMetadata

logger = get_logger(__name__)


def _request_id(request: Request) -> str:
    return getattr(request.state, "request_id", "unknown")


def _build_envelope(request: Request, error: ErrorDetail) -> ErrorEnvelope:
    settings = get_settings()
    return ErrorEnvelope(
        error=error,
        metadata=ResponseMetadata(version="v1", environment=settings.app_env),
        request_id=_request_id(request),
    )


async def http_exception_handler(request: Request, exc: HTTPException) -> JSONResponse:
    """Convert `HTTPException` into an `ErrorEnvelope`.

    Route handlers may raise `HTTPException(detail=ErrorDetail(...).model_dump())`
    for a specific machine-readable code, or a plain string `detail` for
    ad-hoc errors — both are normalized here.
    """
    if isinstance(exc.detail, dict) and {"code", "message"} <= exc.detail.keys():
        error = ErrorDetail(**exc.detail)
    else:
        error = ErrorDetail(code="HTTP_ERROR", message=str(exc.detail))

    envelope = _build_envelope(request, error)
    return JSONResponse(
        status_code=exc.status_code, content=jsonable_encoder(envelope), headers=exc.headers
    )


async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """Last-resort handler so an unexpected error still returns a valid envelope.

    Logs the full exception server-side but never leaks internals to the
    client — the response body is a fixed, generic message.
    """
    logger.exception("Unhandled exception on %s %s", request.method, request.url.path)
    error = ErrorDetail(code="INTERNAL_ERROR", message="An unexpected error occurred.")
    envelope = _build_envelope(request, error)
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, content=jsonable_encoder(envelope)
    )


async def validation_exception_handler(
    request: Request, exc: RequestValidationError
) -> JSONResponse:
    """Convert FastAPI's request-validation errors into an `ErrorEnvelope`.

    Without this, invalid input (e.g. a `query` string that's too short)
    returns Starlette's default `{"detail": [...]}` shape instead of our
    documented envelope — the one inconsistency this module exists to close.
    """
    error = ErrorDetail(code="VALIDATION_ERROR", message="; ".join(
        f"{'.'.join(str(p) for p in e['loc'])}: {e['msg']}" for e in exc.errors()
    ))
    envelope = _build_envelope(request, error)
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, content=jsonable_encoder(envelope)
    )


def register_exception_handlers(app: FastAPI) -> None:
    app.add_exception_handler(HTTPException, http_exception_handler)
    app.add_exception_handler(RequestValidationError, validation_exception_handler)
    app.add_exception_handler(Exception, unhandled_exception_handler)
