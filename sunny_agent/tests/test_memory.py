# test_memory.py
# Purpose: Unit tests for ConversationLogger and shutdown_conversation (memory.py) with a
# fake Convex client that records call order. Covers the end-of-session ordering: pending
# logTurn writes complete before the summary and before the client is closed, a finalize
# started by the disconnect path and a second one from shutdown produce exactly one
# agent:finishConversation, and the client is closed even when finalize fails.
#
# Last modified: 2026-10-29

import asyncio
from typing import Any

import pytest
from livekit.agents.llm import ChatContext

import memory
from memory import ConversationLogger, shutdown_conversation


class FakeClient:
    """
    purpose: Stand-in for ConvexClient that records mutations and aclose in order.
    """

    def __init__(self, delay: float = 0.0, fail_finish: bool = False) -> None:
        """
        purpose: Create the fake.
        @param delay: (float) Seconds each mutation takes, to force overlap.
        @param fail_finish: (bool) Make agent:finishConversation raise.
        """
        self.events: list[str] = []
        self.closed = False
        self._delay = delay
        self._fail_finish = fail_finish

    async def mutation(self, path: str, args: dict[str, Any] | None = None) -> None:
        """
        purpose: Record a mutation, failing if the client is already closed.
        @param path: (str) Function path.
        @param args: (dict | None) Arguments (unused).
        """
        await asyncio.sleep(self._delay)
        if self.closed:
            raise RuntimeError("client is closed")
        if self._fail_finish and path == "agent:finishConversation":
            raise RuntimeError("finish failed")
        self.events.append(path)

    async def aclose(self) -> None:
        """
        purpose: Record that the client was closed.
        """
        self.events.append("aclose")
        self.closed = True


def _history() -> ChatContext:
    """
    purpose: Build a small transcript.
    @return: (ChatContext) History with one user and one assistant message.
    """
    ctx = ChatContext.empty()
    ctx.add_message(role="user", content="What is next?")
    ctx.add_message(role="assistant", content="Lunch at noon.")
    return ctx


@pytest.fixture(autouse=True)
def slow_summary(monkeypatch: pytest.MonkeyPatch) -> None:
    """
    purpose: Replace the Anthropic summary with a slow stub so finalize overlaps shutdown.
    @param monkeypatch: (pytest.MonkeyPatch) Fixture.
    """

    async def fake_summary(self: ConversationLogger, transcript: str) -> str:
        await asyncio.sleep(0.05)
        return "A summary."

    monkeypatch.setattr(ConversationLogger, "_generate_summary", fake_summary)


@pytest.mark.asyncio
async def test_second_finalize_awaits_first_and_finishes_once() -> None:
    """purpose: Disconnect-path finalize plus shutdown finalize give one finish call."""
    client = FakeClient()
    conv = ConversationLogger(client, "c1")  # type: ignore[arg-type]
    history = _history()

    disconnect_task = asyncio.create_task(conv.finalize(history))
    await asyncio.sleep(0)  # let the first finalize start its work
    await shutdown_conversation(client, conv, history)  # type: ignore[arg-type]
    await disconnect_task

    assert client.events == ["agent:finishConversation", "aclose"]


@pytest.mark.asyncio
async def test_pending_log_turns_complete_before_finish_and_close() -> None:
    """purpose: Tracked logTurn writes finish before the summary, finish and aclose."""
    client = FakeClient(delay=0.02)
    conv = ConversationLogger(client, "c1")  # type: ignore[arg-type]
    conv.track_log_message("user", "hello")
    conv.track_log_message("assistant", "hi")

    await shutdown_conversation(client, conv, _history())  # type: ignore[arg-type]

    assert client.events == [
        "agent:logTurn",
        "agent:logTurn",
        "agent:finishConversation",
        "aclose",
    ]


@pytest.mark.asyncio
async def test_wait_idle_drains_turns_started_while_waiting() -> None:
    """purpose: wait_idle returns only when no tracked write is left."""
    client = FakeClient(delay=0.01)
    conv = ConversationLogger(client, "c1")  # type: ignore[arg-type]
    conv.track_log_message("user", "a")
    waiter = asyncio.create_task(conv.wait_idle())
    await asyncio.sleep(0)
    conv.track_log_message("assistant", "b")
    await waiter
    assert client.events.count("agent:logTurn") == 2


@pytest.mark.asyncio
async def test_client_closed_even_if_finish_fails() -> None:
    """purpose: A failing finish is swallowed by finalize and the client still closes."""
    client = FakeClient(fail_finish=True)
    conv = ConversationLogger(client, "c1")  # type: ignore[arg-type]
    await shutdown_conversation(client, conv, _history())  # type: ignore[arg-type]
    assert client.events == ["aclose"]


@pytest.mark.asyncio
async def test_client_closed_when_setup_failed_before_logger_existed() -> None:
    """purpose: With no logger or history the client is still closed."""
    client = FakeClient()
    await shutdown_conversation(client, None, None)  # type: ignore[arg-type]
    assert client.events == ["aclose"]


@pytest.mark.asyncio
async def test_client_closed_when_wait_idle_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """purpose: The close happens in a finally even if draining blows up."""
    client = FakeClient()
    conv = ConversationLogger(client, "c1")  # type: ignore[arg-type]

    async def boom(self: ConversationLogger) -> None:
        raise RuntimeError("drain failed")

    monkeypatch.setattr(ConversationLogger, "wait_idle", boom)
    with pytest.raises(RuntimeError):
        await shutdown_conversation(client, conv, None)  # type: ignore[arg-type]
    assert client.closed


@pytest.mark.asyncio
async def test_empty_conversation_id_disables_logging_and_finalize() -> None:
    """purpose: With no conversation id nothing is written."""
    client = FakeClient()
    conv = ConversationLogger(client, "")  # type: ignore[arg-type]
    conv.track_log_message("user", "hi")
    await shutdown_conversation(client, conv, _history())  # type: ignore[arg-type]
    assert client.events == ["aclose"]


def test_module_exposes_shutdown_helper() -> None:
    """purpose: shutdown_conversation is importable from memory (used by agent.py)."""
    assert memory.shutdown_conversation is shutdown_conversation
