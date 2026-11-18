import asyncio

import pytest
from livekit.agents.llm import ChatContext

import memory
from convex_client import ConvexArgs
from memory import ConversationLogger, SessionRecord, shutdown_conversation


class FakeClient:
    def __init__(self, delay: float = 0.0, fail_finish: bool = False) -> None:
        self.events: list[str] = []
        self.closed = False
        self._delay = delay
        self._fail_finish = fail_finish

    async def mutation(self, path: str, args: ConvexArgs) -> None:
        await asyncio.sleep(self._delay)
        if self.closed:
            raise RuntimeError("client is closed")
        if self._fail_finish and path == "agent:finishConversation":
            raise RuntimeError("finish failed")
        self.events.append(path)

    async def aclose(self) -> None:
        self.events.append("aclose")
        self.closed = True


def _history() -> ChatContext:
    ctx = ChatContext.empty()
    ctx.add_message(role="user", content="What is next?")
    ctx.add_message(role="assistant", content="Lunch at noon.")
    return ctx


@pytest.fixture(autouse=True)
def slow_summary(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_extract(
        self: ConversationLogger, transcript: str, turn_times: dict[int, float]
    ) -> SessionRecord:
        await asyncio.sleep(0.05)
        return SessionRecord(summary="A summary.")

    monkeypatch.setattr(ConversationLogger, "_extract_record", fake_extract)


@pytest.mark.asyncio
async def test_second_finalize_awaits_first_and_finishes_once() -> None:
    client = FakeClient()
    conv = ConversationLogger(client, "c1")
    history = _history()

    disconnect_task = asyncio.create_task(conv.finalize(history))
    await asyncio.sleep(0)
    await shutdown_conversation(client.aclose, conv, history)
    await disconnect_task

    assert client.events == [
        "agent:finishConversation",
        "agent:finishConversation",
        "aclose",
    ]


@pytest.mark.asyncio
async def test_pending_log_turns_complete_before_finish_and_close() -> None:
    client = FakeClient(delay=0.02)
    conv = ConversationLogger(client, "c1")
    conv.track_log_message("user", "hello")
    conv.track_log_message("assistant", "hi")

    await shutdown_conversation(client.aclose, conv, _history())

    assert client.events == [
        "agent:logTurn",
        "agent:logTurn",
        "agent:finishConversation",
        "agent:finishConversation",
        "aclose",
    ]


@pytest.mark.asyncio
async def test_wait_idle_drains_turns_started_while_waiting() -> None:
    client = FakeClient(delay=0.01)
    conv = ConversationLogger(client, "c1")
    conv.track_log_message("user", "a")
    waiter = asyncio.create_task(conv.wait_idle())
    await asyncio.sleep(0)
    conv.track_log_message("assistant", "b")
    await waiter
    assert client.events.count("agent:logTurn") == 2


@pytest.mark.asyncio
async def test_client_closed_even_if_finish_fails() -> None:
    client = FakeClient(fail_finish=True)
    conv = ConversationLogger(client, "c1")
    await shutdown_conversation(client.aclose, conv, _history())
    assert client.events == ["aclose"]


@pytest.mark.asyncio
async def test_client_closed_when_setup_failed_before_logger_existed() -> None:
    client = FakeClient()
    await shutdown_conversation(client.aclose, None, None)
    assert client.events == ["aclose"]


@pytest.mark.asyncio
async def test_client_closed_when_wait_idle_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = FakeClient()
    conv = ConversationLogger(client, "c1")

    async def boom(self: ConversationLogger) -> None:
        raise RuntimeError("drain failed")

    monkeypatch.setattr(ConversationLogger, "wait_idle", boom)
    with pytest.raises(RuntimeError):
        await shutdown_conversation(client.aclose, conv, None)
    assert client.closed


@pytest.mark.asyncio
async def test_empty_conversation_id_disables_logging_and_finalize() -> None:
    client = FakeClient()
    conv = ConversationLogger(client, "")
    conv.track_log_message("user", "hi")
    await shutdown_conversation(client.aclose, conv, _history())
    assert client.events == ["aclose"]


def test_module_exposes_shutdown_helper() -> None:
    assert memory.shutdown_conversation is shutdown_conversation
