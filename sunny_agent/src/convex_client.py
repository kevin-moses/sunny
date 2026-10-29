# convex_client.py
# Purpose: Small async client for Convex's HTTP API, used by the voice agent to read
# household state and write conversation records. Every call goes to
# POST {CONVEX_URL}/api/query or /api/mutation with { path, args, format: "json" } and
# injects the shared agent key (SUNNY_AGENT_KEY) into args, which the agent:* Convex
# functions check. A response with status "error" is raised as ConvexError carrying the
# error code (from errorData when present) and message. create_convex_client() builds a
# client from CONVEX_URL and SUNNY_AGENT_KEY in the environment.
#
# Last modified: 2026-10-29

import os
from typing import Any

import httpx

_TIMEOUT = httpx.Timeout(10.0, connect=5.0)


class ConvexError(Exception):
    """
    purpose: Raised when Convex reports an error for a query or mutation.
    """

    def __init__(self, code: str, message: str) -> None:
        """
        purpose: Store the error code and message.
        @param code: (str) errorData.code when Convex sent one, otherwise "error".
        @param message: (str) Human-readable error message.
        """
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


class ConvexClient:
    """
    purpose: Async wrapper over Convex's /api/query and /api/mutation endpoints that
             adds the agent key to every call.
    """

    def __init__(
        self,
        url: str,
        agent_key: str,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        """
        purpose: Create the client and its underlying HTTP connection pool.
        @param url: (str) Convex deployment URL, e.g. https://example.convex.cloud.
        @param agent_key: (str) Shared secret sent as args.agentKey on every call.
        @param transport: (httpx.AsyncBaseTransport | None) Override for tests.
        """
        self._agent_key = agent_key
        self._http = httpx.AsyncClient(
            base_url=url.rstrip("/"), timeout=_TIMEOUT, transport=transport
        )

    async def query(self, path: str, args: dict[str, Any] | None = None) -> Any:
        """
        purpose: Run a Convex query.
        @param path: (str) Function path, e.g. "agent:today".
        @param args: (dict | None) Function arguments; agentKey is added automatically.
        @return: The query's JSON value.
        @raises: ConvexError on a Convex error; httpx.HTTPError on transport failure
                 or a non-2xx HTTP status without a Convex error body.
        """
        return await self._call("query", path, args)

    async def mutation(self, path: str, args: dict[str, Any] | None = None) -> Any:
        """
        purpose: Run a Convex mutation.
        @param path: (str) Function path, e.g. "agent:logTurn".
        @param args: (dict | None) Function arguments; agentKey is added automatically.
        @return: The mutation's JSON value.
        @raises: ConvexError on a Convex error; httpx.HTTPError on transport failure
                 or a non-2xx HTTP status without a Convex error body.
        """
        return await self._call("mutation", path, args)

    async def aclose(self) -> None:
        """
        purpose: Close the underlying HTTP connection pool.
        """
        await self._http.aclose()

    async def _call(self, kind: str, path: str, args: dict[str, Any] | None) -> Any:
        """
        purpose: POST one function call and unwrap the Convex response envelope.
        @param kind: (str) "query" or "mutation".
        @param path: (str) Function path.
        @param args: (dict | None) Function arguments before agentKey is added.
        @return: The "value" of a successful response.
        """
        body = {
            "path": path,
            "args": {**(args or {}), "agentKey": self._agent_key},
            "format": "json",
        }
        response = await self._http.post(f"/api/{kind}", json=body)
        try:
            payload = response.json()
        except ValueError:
            payload = None
        if isinstance(payload, dict) and payload.get("status") == "error":
            data = payload.get("errorData")
            code = data.get("code") if isinstance(data, dict) else None
            message = payload.get("errorMessage") or "Convex error"
            raise ConvexError(code or "error", message)
        response.raise_for_status()
        if not isinstance(payload, dict) or payload.get("status") != "success":
            raise ConvexError("bad_response", f"Unexpected response from {path}")
        return payload.get("value")


def create_convex_client() -> ConvexClient:
    """
    purpose: Build a ConvexClient from environment variables.
    @return: (ConvexClient) Client for the configured deployment.
    @raises: KeyError if CONVEX_URL or SUNNY_AGENT_KEY are not set.
    """
    return ConvexClient(os.environ["CONVEX_URL"], os.environ["SUNNY_AGENT_KEY"])
