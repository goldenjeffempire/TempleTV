"""Shared pytest fixtures for the SDK test suite."""

from collections.abc import AsyncGenerator

import pytest

from joe_sdk import JKPClient

BASE_URL = "http://testserver/v1"


def envelope(data: object) -> dict:
    """Build a minimal success envelope matching the API's real response contract."""
    return {
        "success": True,
        "data": data,
        "metadata": {"version": "v1", "environment": "test"},
        "timestamp": "2026-01-01T00:00:00Z",
        "request_id": "test-request-id",
    }


def error_envelope(code: str, message: str) -> dict:
    """Build a minimal error envelope matching the API's real error contract."""
    return {
        "success": False,
        "error": {"code": code, "message": message},
        "metadata": {"version": "v1", "environment": "test"},
        "timestamp": "2026-01-01T00:00:00Z",
        "request_id": "test-request-id",
    }


@pytest.fixture
async def client() -> AsyncGenerator[JKPClient, None]:
    async with JKPClient(base_url=BASE_URL) as c:
        yield c
