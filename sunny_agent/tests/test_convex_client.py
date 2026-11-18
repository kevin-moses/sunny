import json
from collections.abc import Callable

import httpx
import pytest

import convex_client
from convex_client import (
    ConvexClient,
    ConvexError,
    create_convex_client,
    mutation_as,
    query_as,
)
from convex_types import CONFIRM_RESULT, OPEN_LIST_ITEMS


def _client(handler: Callable[[httpx.Request], httpx.Response]) -> ConvexClient:
    return ConvexClient(
        "https://x.convex.cloud/", "k", transport=httpx.MockTransport(handler)
    )


@pytest.mark.asyncio
async def test_query_posts_to_query_endpoint_with_agent_key() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"status": "success", "value": [1, 2]})

    result = await _client(handler).query("agent:today", {"householdId": "h1"})
    assert result == [1, 2]
    assert str(seen[0].url) == "https://x.convex.cloud/api/query"
    assert json.loads(seen[0].content) == {
        "path": "agent:today",
        "args": {"householdId": "h1", "agentKey": "k"},
        "format": "json",
    }


@pytest.mark.asyncio
async def test_mutation_posts_to_mutation_endpoint() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"status": "success", "value": None})

    assert await _client(handler).mutation("agent:logTurn") is None
    assert seen[0].url.path == "/api/mutation"
    assert json.loads(seen[0].content)["args"] == {"agentKey": "k"}


@pytest.mark.asyncio
async def test_error_with_error_data_raises_typed_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "status": "error",
                "errorMessage": "boom",
                "errorData": {"code": "unauthorized", "message": "bad key"},
            },
        )

    with pytest.raises(ConvexError) as exc:
        await _client(handler).query("agent:today", {})
    assert exc.value.code == "unauthorized"
    assert exc.value.message == "boom"


@pytest.mark.asyncio
async def test_error_without_error_data_uses_default_code() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={"status": "error", "errorMessage": "bad"})

    with pytest.raises(ConvexError) as exc:
        await _client(handler).mutation("agent:logTurn", {})
    assert exc.value.code == "error"
    assert exc.value.message == "bad"


@pytest.mark.asyncio
async def test_http_failure_without_convex_body_raises_http_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="oops")

    with pytest.raises(httpx.HTTPStatusError):
        await _client(handler).query("agent:today", {})


@pytest.mark.asyncio
async def test_transport_failure_propagates() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("down")

    with pytest.raises(httpx.ConnectError):
        await _client(handler).query("agent:today", {})


@pytest.mark.asyncio
async def test_unexpected_success_body_raises() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"hello": "world"})

    with pytest.raises(ConvexError) as exc:
        await _client(handler).query("agent:today", {})
    assert exc.value.code == "bad_response"


@pytest.mark.asyncio
async def test_agent_key_is_redacted_from_error_message() -> None:
    def echo_handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "status": "error",
                "errorMessage": "args {agentKey: 'secret-key-123'}",
                "errorData": {"code": "x-secret-key-123"},
            },
        )

    client = ConvexClient(
        "https://x.convex.cloud",
        "secret-key-123",
        transport=httpx.MockTransport(echo_handler),
    )
    with pytest.raises(ConvexError) as exc:
        await client.query("agent:today", {})
    assert "secret-key-123" not in str(exc.value)
    assert "secret-key-123" not in exc.value.message
    assert "secret-key-123" not in exc.value.code
    assert "[redacted]" in exc.value.message


@pytest.fixture
def no_backoff(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(convex_client, "_RETRY_BACKOFF_SECONDS", 0)


@pytest.mark.asyncio
@pytest.mark.parametrize("error", [httpx.ConnectError, httpx.ConnectTimeout])
async def test_query_retries_once_on_connect_failure(
    no_backoff: None, error: type[httpx.TransportError]
) -> None:
    attempts = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise error("down")
        return httpx.Response(200, json={"status": "success", "value": 7})

    assert await _client(handler).query("agent:today", {}) == 7
    assert attempts == 2


@pytest.mark.asyncio
async def test_query_gives_up_after_one_retry(no_backoff: None) -> None:
    attempts = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        raise httpx.ConnectError("down")

    with pytest.raises(httpx.ConnectError):
        await _client(handler).query("agent:today", {})
    assert attempts == 2


@pytest.mark.asyncio
async def test_mutation_is_never_retried(no_backoff: None) -> None:
    attempts = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        raise httpx.ConnectError("down")

    with pytest.raises(httpx.ConnectError):
        await _client(handler).mutation("agent:logTurn", {})
    assert attempts == 1


@pytest.mark.asyncio
async def test_query_does_not_retry_other_transport_errors(no_backoff: None) -> None:
    attempts = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        raise httpx.ReadTimeout("slow")

    with pytest.raises(httpx.ReadTimeout):
        await _client(handler).query("agent:today", {})
    assert attempts == 1


def test_factory_reads_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CONVEX_URL", "https://x.convex.cloud")
    monkeypatch.setenv("SUNNY_AGENT_KEY", "k")
    assert isinstance(create_convex_client(), ConvexClient)


@pytest.mark.parametrize("missing", ["CONVEX_URL", "SUNNY_AGENT_KEY"])
def test_factory_raises_key_error_when_missing(
    monkeypatch: pytest.MonkeyPatch, missing: str
) -> None:
    monkeypatch.setenv("CONVEX_URL", "https://x.convex.cloud")
    monkeypatch.setenv("SUNNY_AGENT_KEY", "k")
    monkeypatch.delenv(missing)
    with pytest.raises(KeyError):
        create_convex_client()


def _returning(value: object) -> ConvexClient:
    return _client(
        lambda request: httpx.Response(200, json={"status": "success", "value": value})
    )


@pytest.mark.asyncio
async def test_typed_calls_return_the_value_when_it_has_the_declared_shape() -> None:
    items = await query_as(_returning(["milk"]), "agent:listItems", {}, OPEN_LIST_ITEMS)
    assert items == ["milk"]
    result = await mutation_as(
        _returning({"status": "nothing_due"}),
        "agent:confirmDueTask",
        {},
        CONFIRM_RESULT,
    )
    assert result == {"status": "nothing_due"}


@pytest.mark.asyncio
async def test_typed_calls_refuse_a_value_with_another_shape() -> None:
    with pytest.raises(ConvexError) as exc:
        await mutation_as(
            _returning({"status": "done"}), "agent:confirmDueTask", {}, CONFIRM_RESULT
        )
    assert exc.value.code == "bad_response"
    assert (
        exc.value.message == "Unexpected response from agent:confirmDueTask at status"
    )
    with pytest.raises(ConvexError):
        await query_as(_returning([1]), "agent:listItems", {}, OPEN_LIST_ITEMS)
