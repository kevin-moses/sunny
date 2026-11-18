import asyncio
import os
from collections.abc import Mapping
from typing import Protocol, TypeVar

import httpx
from pydantic import TypeAdapter, ValidationError

_TIMEOUT = httpx.Timeout(10.0, connect=5.0)
_RETRY_BACKOFF_SECONDS = 0.25
_REDACTED = "[redacted]"

ConvexArgs = Mapping[str, object]

T = TypeVar("T")


class ConvexQuery(Protocol):
    async def query(self, path: str, args: ConvexArgs) -> object: ...


class ConvexMutation(Protocol):
    async def mutation(self, path: str, args: ConvexArgs) -> object: ...


class ConvexApi(ConvexQuery, ConvexMutation, Protocol):
    pass


class ConvexError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


async def query_as(
    client: ConvexQuery, path: str, args: ConvexArgs, returns: TypeAdapter[T]
) -> T:
    return _validated(path, returns, await client.query(path, args))


async def mutation_as(
    client: ConvexMutation, path: str, args: ConvexArgs, returns: TypeAdapter[T]
) -> T:
    return _validated(path, returns, await client.mutation(path, args))


def _validated(path: str, returns: TypeAdapter[T], value: object) -> T:
    try:
        return returns.validate_python(value)
    except ValidationError as e:
        fields = ", ".join(
            ".".join(str(part) for part in error["loc"]) or "value"
            for error in e.errors(include_input=False)
        )
        raise ConvexError(
            "bad_response", f"Unexpected response from {path} at {fields}"
        ) from None


class ConvexClient:
    def __init__(
        self,
        url: str,
        agent_key: str,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._agent_key = agent_key
        self._http = httpx.AsyncClient(
            base_url=url.rstrip("/"), timeout=_TIMEOUT, transport=transport
        )

    async def query(self, path: str, args: ConvexArgs | None = None) -> object:
        return await self._call("query", path, args)

    async def mutation(self, path: str, args: ConvexArgs | None = None) -> object:
        return await self._call("mutation", path, args)

    async def aclose(self) -> None:
        await self._http.aclose()

    def _redact(self, text: str) -> str:
        if not self._agent_key:
            return text
        return text.replace(self._agent_key, _REDACTED)

    async def _post(self, kind: str, body: dict[str, object]) -> httpx.Response:
        try:
            return await self._http.post(f"/api/{kind}", json=body)
        except (httpx.ConnectError, httpx.ConnectTimeout):
            if kind != "query":
                raise
            await asyncio.sleep(_RETRY_BACKOFF_SECONDS)
            return await self._http.post(f"/api/{kind}", json=body)

    async def _call(self, kind: str, path: str, args: ConvexArgs | None) -> object:
        body: dict[str, object] = {
            "path": path,
            "args": {**(args or {}), "agentKey": self._agent_key},
            "format": "json",
        }
        response = await self._post(kind, body)
        try:
            payload = response.json()
        except ValueError:
            payload = None
        if isinstance(payload, dict) and payload.get("status") == "error":
            data = payload.get("errorData")
            code = data.get("code") if isinstance(data, dict) else None
            message = payload.get("errorMessage") or "Convex error"
            raise ConvexError(
                self._redact(str(code or "error")), self._redact(str(message))
            )
        response.raise_for_status()
        if not isinstance(payload, dict) or payload.get("status") != "success":
            raise ConvexError("bad_response", f"Unexpected response from {path}")
        return payload.get("value")


def create_convex_client() -> ConvexClient:
    return ConvexClient(os.environ["CONVEX_URL"], os.environ["SUNNY_AGENT_KEY"])
