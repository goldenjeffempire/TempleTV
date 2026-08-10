"""ASGI middleware shared across the API."""

import time
import uuid
from collections.abc import Awaitable, Callable

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

from app.core.metrics import REQUEST_COUNT, REQUEST_DURATION_SECONDS

REQUEST_ID_HEADER = "X-Request-ID"


class RequestIDMiddleware(BaseHTTPMiddleware):
    """Attach a unique request ID to every request/response pair.

    The ID is generated per-request (or reused if the caller already
    supplied one via the `X-Request-ID` header, which is useful for
    tracing a request across service boundaries), stored on `request.state`
    for handlers/envelopes to read, and echoed back in the response header.
    """

    async def dispatch(
        self, request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        request_id = request.headers.get(REQUEST_ID_HEADER, str(uuid.uuid4()))
        request.state.request_id = request_id

        response = await call_next(request)
        response.headers[REQUEST_ID_HEADER] = request_id
        return response


class MetricsMiddleware(BaseHTTPMiddleware):
    """Record `http_requests_total` and `http_request_duration_seconds` per request.

    Skips `/metrics` itself, so scrapes don't pollute the very metrics
    they're scraping.
    """

    async def dispatch(
        self, request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        if request.url.path == "/metrics":
            return await call_next(request)

        start = time.perf_counter()
        response = await call_next(request)
        duration = time.perf_counter() - start

        # Only available *after* call_next, once routing has actually
        # matched a route — reading it any earlier would just be None.
        # Falling back to a fixed "unmatched" label (never the raw path)
        # for 404s keeps cardinality bounded regardless of what garbage
        # paths get requested.
        route = request.scope.get("route")
        path_template = route.path if route is not None else "unmatched"

        REQUEST_COUNT.labels(
            method=request.method, path_template=path_template, status_code=response.status_code
        ).inc()
        REQUEST_DURATION_SECONDS.labels(
            method=request.method, path_template=path_template
        ).observe(duration)

        return response


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Add standard security-related response headers ("Helmet-equivalent" per
    the project spec's Security section — Helmet is the Express.js/Node
    library most engineers mean by that shorthand; this is its FastAPI
    equivalent).

    Deliberately does NOT set a `Content-Security-Policy`: this API also
    serves `/v1/docs` (Swagger UI) and `/v1/redoc`, both of which load
    external JS/CSS and would need a carefully-tuned CSP to keep working —
    getting that wrong silently breaks the interactive docs rather than
    failing loudly, which isn't a good trade for a header whose main value
    here (an API that returns JSON, not attacker-controlled HTML) is
    already covered by `X-Content-Type-Options: nosniff` below. Worth
    revisiting with a real CSP once/if this serves any HTML of its own.
    """

    async def dispatch(
        self, request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        response = await call_next(request)

        # Stop browsers from MIME-sniffing a response away from the
        # declared Content-Type — relevant even for a JSON API, since a
        # sniffed-as-HTML response body containing attacker-controlled
        # text is how a JSON endpoint becomes an XSS vector.
        response.headers["X-Content-Type-Options"] = "nosniff"
        # This API is never meant to be framed; blocks clickjacking-style
        # embedding of any HTML it does serve (Swagger UI, error pages).
        response.headers["X-Frame-Options"] = "DENY"
        # Modern replacement for the deprecated/removed browser XSS
        # auditor — "0" explicitly disables it rather than leaving it
        # implicit, since the legacy auditor itself has been used as an
        # XSS vector in some browsers.
        response.headers["X-XSS-Protection"] = "0"
        # Don't leak full request URLs (which may contain query params) to
        # third-party origins via the Referer header on cross-origin
        # navigation/requests; still allows same-origin referrers.
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        # No legitimate reason for an API backend's responses to grant a
        # browser access to these — cheap to deny by default.
        response.headers["Permissions-Policy"] = "geolocation=(), camera=(), microphone=()"
        # Ignored by browsers on plain HTTP per the HSTS spec itself, so
        # safe to always send rather than conditionally checking whether
        # the current request happened to arrive over TLS (which, behind a
        # reverse proxy terminating TLS, this app often can't reliably
        # determine from the request alone anyway).
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"

        return response
