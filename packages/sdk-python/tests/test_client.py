"""Tests for `JKPClient`. All HTTP calls are mocked via respx — no real network."""

import pytest
import respx
from httpx import Response

from joe_sdk import (
    JKPAuthenticationError,
    JKPClient,
    JKPNotFoundError,
    JKPPermissionError,
    JKPRateLimitError,
    JKPValidationError,
)
from tests.conftest import BASE_URL, envelope, error_envelope


class TestKnowledgeReads:
    @respx.mock
    async def test_get_knowledge_overview_returns_unwrapped_data(
        self, client: JKPClient
    ) -> None:
        respx.get(f"{BASE_URL}/knowledge").mock(
            return_value=Response(200, json=envelope([{"country_iso_code": "NG"}]))
        )
        result = await client.get_knowledge_overview()
        assert result == [{"country_iso_code": "NG"}]

    @respx.mock
    async def test_get_service(self, client: JKPClient) -> None:
        respx.get(f"{BASE_URL}/services/ng-business-name-registration").mock(
            return_value=Response(200, json=envelope({"slug": "ng-business-name-registration"}))
        )
        result = await client.get_service("ng-business-name-registration")
        assert result["slug"] == "ng-business-name-registration"

    @respx.mock
    async def test_get_service_not_found_raises_with_code(self, client: JKPClient) -> None:
        respx.get(f"{BASE_URL}/services/does-not-exist").mock(
            return_value=Response(
                404, json=error_envelope("SERVICE_NOT_FOUND", "No service found.")
            )
        )
        with pytest.raises(JKPNotFoundError) as exc_info:
            await client.get_service("does-not-exist")
        assert exc_info.value.code == "SERVICE_NOT_FOUND"
        assert exc_info.value.status_code == 404

    @respx.mock
    async def test_search_passes_query_and_limit_params(self, client: JKPClient) -> None:
        route = respx.get(f"{BASE_URL}/search").mock(return_value=Response(200, json=envelope([])))
        await client.search("business name", limit=5)
        assert route.calls.last.request.url.params["q"] == "business name"
        assert route.calls.last.request.url.params["limit"] == "5"


class TestAuth:
    @respx.mock
    async def test_login_updates_bearer_token_for_subsequent_requests(
        self, client: JKPClient
    ) -> None:
        respx.post(f"{BASE_URL}/auth/login").mock(
            return_value=Response(
                200,
                json=envelope(
                    {"access_token": "abc123", "refresh_token": "def456", "token_type": "bearer"}
                ),
            )
        )
        me_route = respx.get(f"{BASE_URL}/auth/me").mock(
            return_value=Response(200, json=envelope({"email": "x@example.com"}))
        )

        await client.login("x@example.com", "correct password")
        await client.get_me()

        assert me_route.calls.last.request.headers["Authorization"] == "Bearer abc123"

    @respx.mock
    async def test_wrong_credentials_raises_authentication_error(
        self, client: JKPClient
    ) -> None:
        respx.post(f"{BASE_URL}/auth/login").mock(
            return_value=Response(
                401, json=error_envelope("INVALID_CREDENTIALS", "Incorrect email or password.")
            )
        )
        with pytest.raises(JKPAuthenticationError):
            await client.login("x@example.com", "wrong password")

    @respx.mock
    async def test_login_rate_limited_raises_rate_limit_error(self, client: JKPClient) -> None:
        respx.post(f"{BASE_URL}/auth/login").mock(
            return_value=Response(
                429, json=error_envelope("RATE_LIMITED", "Too many attempts. Try again shortly.")
            )
        )
        with pytest.raises(JKPRateLimitError) as exc_info:
            await client.login("x@example.com", "whatever")
        assert exc_info.value.status_code == 429

    @respx.mock
    async def test_refresh_updates_bearer_token(self, client: JKPClient) -> None:
        respx.post(f"{BASE_URL}/auth/refresh").mock(
            return_value=Response(
                200,
                json=envelope(
                    {"access_token": "new-token", "refresh_token": "new-refresh", "token_type": "bearer"}
                ),
            )
        )
        me_route = respx.get(f"{BASE_URL}/auth/me").mock(
            return_value=Response(200, json=envelope({"email": "x@example.com"}))
        )

        await client.refresh("some-old-refresh-token")
        await client.get_me()

        assert me_route.calls.last.request.headers["Authorization"] == "Bearer new-token"


class TestClientConstruction:
    def test_api_key_sent_as_header(self) -> None:
        client = JKPClient(base_url=BASE_URL, api_key="jkp_live_abc123")
        assert client._http.headers["X-API-Key"] == "jkp_live_abc123"

    def test_access_token_sent_as_bearer_header(self) -> None:
        client = JKPClient(base_url=BASE_URL, access_token="abc123")
        assert client._http.headers["Authorization"] == "Bearer abc123"

    def test_cannot_pass_both_api_key_and_access_token(self) -> None:
        with pytest.raises(ValueError):
            JKPClient(base_url=BASE_URL, api_key="a", access_token="b")

    def test_base_url_without_trailing_slash_still_joins_correctly(self) -> None:
        """Regression test: httpx merges a relative request path onto
        base_url by concatenation, not full URL resolution — a base_url
        without a trailing slash combined with a leading-slash request path
        can silently produce a mangled URL (e.g. '/v1' + '/knowledge'
        becoming '/v1knowledge', missing a slash). `JKPClient` normalizes
        this internally; callers shouldn't have to know or care."""
        client = JKPClient(base_url="http://testserver/v1")  # deliberately no trailing slash
        assert str(client._http.base_url) == "http://testserver/v1/"

    async def test_context_manager_closes_underlying_client(self) -> None:
        async with JKPClient(base_url=BASE_URL) as client:
            pass
        assert client._http.is_closed


class TestWrites:
    @respx.mock
    async def test_create_service_without_permission_raises(self, client: JKPClient) -> None:
        respx.post(f"{BASE_URL}/services").mock(
            return_value=Response(
                403, json=error_envelope("PERMISSION_DENIED", "Requires knowledge:write.")
            )
        )
        with pytest.raises(JKPPermissionError):
            await client.create_service(
                agency_id="x", name="x", slug="x", category="x", description="x"
            )

    @respx.mock
    async def test_delete_service_handles_204_no_content(self, client: JKPClient) -> None:
        """The one endpoint in this API that returns an empty body — must
        not attempt to JSON-parse it."""
        respx.delete(f"{BASE_URL}/services/some-slug").mock(return_value=Response(204))
        result = await client.delete_service("some-slug")
        assert result is None

    @respx.mock
    async def test_add_fee_validation_error_raises_with_code(self, client: JKPClient) -> None:
        respx.post(f"{BASE_URL}/services/some-slug/fees").mock(
            return_value=Response(
                422, json=error_envelope("VALIDATION_ERROR", "amount: must be greater than 0")
            )
        )
        with pytest.raises(JKPValidationError):
            await client.add_fee("some-slug", name="Bad fee", amount=0, currency="NGN")
