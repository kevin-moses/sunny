# test_screen_describer.py
# Purpose: Unit tests for ScreenDescriber — the background Gemini screen description
# component of the hybrid vision router. Covers: on_frame_captured event-driven
# triggering, rate limiting, concurrent guard, describe_now cache behavior, on-demand
# Gemini call when stale, start/stop callback wiring, JSON-to-text conversion, and
# re-describe logic (newer frame arriving during an in-flight Gemini call).
# All tests use mocks — no Google Gemini, LiveKit, or Supabase network calls are made.
#
# Last modified: 2026-03-03

import asyncio
import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from screen_describer import ScreenDescriber

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_screen_capture():
    """
    purpose: Build a mock ScreenCapture for describer tests (SCREEN-9).
             Exposes set_on_frame_captured so start() and stop() can wire/unwire.
    @return: MagicMock simulating ScreenCapture.
    """
    sc = MagicMock()
    sc.set_on_frame_captured = MagicMock()
    sc.last_frame_change_time = 0.0
    return sc


def _make_engine(step_ctx: str | None = None):
    """
    purpose: Build a mock WorkflowEngine with configurable step context.
    @param step_ctx: (str | None) Return value for get_current_step_context().
    @return: MagicMock simulating WorkflowEngine.
    """
    engine = MagicMock()
    engine.get_current_step_context.return_value = step_ctx
    return engine


def _make_describer(
    *,
    step_ctx: str | None = None,
    gemini_response: str = '{"current_app":"Settings","current_screen":"Main","notable_elements":[],"target_visible":null,"target_description":"","target_position":"","step_complete":null,"unexpected_elements":[]}',
) -> tuple[ScreenDescriber, MagicMock]:
    """
    purpose: Build a ScreenDescriber with mocked screen capture, engine, and Gemini client.
    @param step_ctx: (str | None) Step context from engine.
    @param gemini_response: (str) JSON string Gemini returns.
    @return: (ScreenDescriber, mock_genai_client) tuple.
    """
    sc = _make_screen_capture()
    engine = _make_engine(step_ctx=step_ctx)

    mock_response = MagicMock()
    mock_response.text = gemini_response

    mock_genai_client = MagicMock()
    mock_genai_client.aio.models.generate_content = AsyncMock(
        return_value=mock_response
    )

    with patch("screen_describer.genai.Client", return_value=mock_genai_client):
        describer = ScreenDescriber(sc, engine)

    return describer, mock_genai_client


# ---------------------------------------------------------------------------
# Test 1: on_frame_captured triggers a background Gemini describe
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_on_frame_captured_triggers_describe() -> None:
    """
    purpose: When on_frame_captured is called with frame bytes, a background Gemini
             describe task should be scheduled and run, updating the description.
    """
    fake_bytes = b"\xff\xd8\xff" + b"\x00" * 10
    describer, mock_client = _make_describer()
    describer._last_describe_time = 0.0  # bypass rate limit

    describer.on_frame_captured(fake_bytes)
    # yield to let the created task run; sufficient because _call_gemini is an AsyncMock
    # that resolves in a single await — if _describe gains more await points, increase this
    await asyncio.sleep(0)

    mock_client.aio.models.generate_content.assert_called_once()
    assert describer.get_description() is not None


# ---------------------------------------------------------------------------
# Test 2: on_frame_captured is rate-limited (only one describe per window)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_on_frame_captured_rate_limited() -> None:
    """
    purpose: When on_frame_captured is called twice within DESCRIBE_RATE_LIMIT_S,
             Gemini should only be called once (the second call is rate-limited).
    """
    fake_bytes = b"\xff\xd8\xff" + b"\x00" * 10
    describer, mock_client = _make_describer()
    describer._last_describe_time = 0.0  # bypass initial rate limit

    describer.on_frame_captured(fake_bytes)
    # Second call immediately after — _last_describe_time was just set, so rate-limited
    describer.on_frame_captured(fake_bytes)
    await asyncio.sleep(0)

    mock_client.aio.models.generate_content.assert_called_once()


# ---------------------------------------------------------------------------
# Test 3: on_frame_captured skips describe when one is already in flight
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_on_frame_captured_concurrent_guard() -> None:
    """
    purpose: When _describing is True, on_frame_captured should not start another
             background describe task, even if the rate limit window has passed.
    """
    fake_bytes = b"\xff\xd8\xff" + b"\x00" * 10
    describer, mock_client = _make_describer()
    describer._describing = True  # simulate in-flight describe
    describer._last_describe_time = 0.0  # bypass rate limit

    describer.on_frame_captured(fake_bytes)
    await asyncio.sleep(0)

    mock_client.aio.models.generate_content.assert_not_called()


# ---------------------------------------------------------------------------
# Test 4: describe_now returns cached description if very fresh
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_describe_now_returns_cached_if_fresh() -> None:
    """
    purpose: When the cached description is less than 1 second old, describe_now()
             should return the cache immediately without calling Gemini.
    """
    describer, mock_client = _make_describer()

    # Pre-populate cache with a very fresh description
    describer._latest_description_text = "App: Settings | Screen: Main"
    describer._last_description_time = time.monotonic()  # just now

    result = await describer.describe_now()

    assert result == "App: Settings | Screen: Main"
    mock_client.aio.models.generate_content.assert_not_called()


# ---------------------------------------------------------------------------
# Test 5: describe_now calls Gemini when description is stale (> 1s old)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_describe_now_calls_gemini_when_stale() -> None:
    """
    purpose: When the cached description is older than 1 second, describe_now()
             should call Gemini and return the fresh result.
    """
    fake_bytes = b"\xff\xd8\xff" + b"\x00" * 10
    describer, mock_client = _make_describer()
    describer._latest_received_frame = fake_bytes

    # Stale cached description
    describer._latest_description_text = "App: Old | Screen: OldScreen"
    describer._last_description_time = time.monotonic() - 2.0  # 2s ago

    result = await describer.describe_now()

    mock_client.aio.models.generate_content.assert_called_once()
    assert result is not None
    assert "Settings" in result  # from default gemini_response fixture


# ---------------------------------------------------------------------------
# Test 6: stop clears callback and all state
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_stop_clears_callback() -> None:
    """
    purpose: After stop() is called, set_on_frame_captured(None) should have been
             called on the screen capture, and all internal state should be cleared.
    """
    describer, _ = _make_describer()
    describer._latest_description_text = "some text"
    describer._last_description_time = 1.0
    describer._last_describe_time = 2.0
    describer._latest_received_frame = b"\xff\xd8"

    describer.stop()

    describer._screen_capture.set_on_frame_captured.assert_called_with(None)
    assert describer._latest_description_text is None
    assert describer._latest_received_frame is None
    assert describer._last_described_frame is None
    assert describer._last_description_time == 0.0
    assert describer._last_describe_time == 0.0
    assert describer._describing is False
    assert describer._stopped is True


# ---------------------------------------------------------------------------
# Test 7: on_description_ready callback is fired after successful describe
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_on_description_ready_callback_fired() -> None:
    """
    purpose: After a successful _describe() call, the registered on_description_ready
             callback should be invoked with the new description text.
    """
    fake_bytes = b"\xff\xd8\xff" + b"\x00" * 10
    describer, _ = _make_describer()

    received: list[str] = []

    def _callback(desc: str) -> None:
        """
        purpose: Capture descriptions delivered by the callback.
        @param desc: (str) The new description text.
        """
        received.append(desc)

    describer.set_on_description_ready(_callback)
    await describer._describe(fake_bytes)

    assert len(received) == 1, "Callback should have been called once"
    assert "Settings" in received[0]


# ---------------------------------------------------------------------------
# Test 8: _json_to_text handles markdown-fenced JSON from Gemini
# ---------------------------------------------------------------------------


def test_json_to_text_strips_markdown_fences() -> None:
    """
    purpose: Assert _json_to_text strips ```json ... ``` markdown code fences
             that Gemini sometimes adds despite strict prompting, and still returns
             a valid human-readable text block.
    """
    describer, _ = _make_describer()
    fenced = '```json\n{"current_app":"Safari","current_screen":"Address Bar","notable_elements":[{"label":"Back","position":"top left","state":"enabled"}],"target_visible":null,"target_description":"","target_position":"","step_complete":null,"unexpected_elements":[]}\n```'

    result = describer._json_to_text(fenced)

    assert "Safari" in result
    assert "Address Bar" in result
    assert "Back" in result
    assert "```" not in result


# ---------------------------------------------------------------------------
# Test 9: _json_to_text falls back gracefully on invalid JSON
# ---------------------------------------------------------------------------


def test_json_to_text_fallback_on_invalid_json() -> None:
    """
    purpose: When Gemini returns non-JSON text (parse error), _json_to_text
             should return the raw string rather than raising an exception.
    """
    describer, _ = _make_describer()
    raw = "I can see the Settings app with a list of options."

    result = describer._json_to_text(raw)

    assert result == raw, "Should return raw text on JSON parse failure"


# ---------------------------------------------------------------------------
# Test 10: describe_now returns fallback when no frame is available
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_describe_now_no_frame_returns_fallback() -> None:
    """
    purpose: When _latest_received_frame is None and no cached description exists,
             describe_now() should return a safe fallback string without calling Gemini.
    """
    describer, mock_client = _make_describer()
    describer._latest_received_frame = None

    result = await describer.describe_now()

    mock_client.aio.models.generate_content.assert_not_called()
    assert isinstance(result, str) and len(result) > 0


# ---------------------------------------------------------------------------
# Test 11: on_frame_captured always stores frame even when rate-limited
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_on_frame_captured_stores_frame_even_when_rate_limited() -> None:
    """
    purpose: Even when rate-limited, on_frame_captured should always update
             _latest_received_frame so describe_now() can use the freshest frame.
    """
    first_bytes = b"\xff\xd8\x01"
    second_bytes = b"\xff\xd8\x02"
    describer, _ = _make_describer()
    describer._last_describe_time = 0.0  # allow first call

    describer.on_frame_captured(first_bytes)
    # Now rate-limited (_last_describe_time was just set)
    describer.on_frame_captured(second_bytes)

    assert describer._latest_received_frame == second_bytes, (
        "_latest_received_frame should always reflect the newest frame"
    )


# ---------------------------------------------------------------------------
# Test 12: start wires on_frame_captured callback to ScreenCapture
# ---------------------------------------------------------------------------


def test_start_wires_callback() -> None:
    """
    purpose: After start(), set_on_frame_captured should have been called with
             describer.on_frame_captured, confirming event-driven wiring (SCREEN-9).
    """
    describer, _ = _make_describer()
    describer.start()

    describer._screen_capture.set_on_frame_captured.assert_called_once_with(
        describer.on_frame_captured
    )


# ---------------------------------------------------------------------------
# Test 13: describe_now uses _latest_received_frame (not consume_frame_bytes)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_describe_now_uses_latest_received_frame() -> None:
    """
    purpose: describe_now() should pass _latest_received_frame to Gemini.
             Verifies the SCREEN-9 migration from consume_frame_bytes to stored field.
    """
    fake_bytes = b"\xff\xd8\xab\xcd"
    describer, mock_client = _make_describer()
    describer._latest_received_frame = fake_bytes
    describer._last_description_time = 0.0  # force stale

    await describer.describe_now()

    mock_client.aio.models.generate_content.assert_called_once()


# ---------------------------------------------------------------------------
# Test 14: _describe bails when _stopped is True (post-stop race guard)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_describe_bails_when_stopped() -> None:
    """
    purpose: If _stopped is True when _describe acquires the lock (i.e. stop() was
             called while a task was queued), Gemini must not be called and
             on_description_ready must not fire. Covers the post-stop race fix.
    """
    fake_bytes = b"\xff\xd8\xff" + b"\x00" * 10
    describer, mock_client = _make_describer()
    fired: list[str] = []
    describer.set_on_description_ready(lambda d: fired.append(d))
    describer._stopped = True  # simulate stop() was called before task ran

    await describer._describe(fake_bytes)

    mock_client.aio.models.generate_content.assert_not_called()
    assert fired == [], "on_description_ready must not fire after stop()"


# ---------------------------------------------------------------------------
# Test 15: _describe re-describes when a newer frame arrived during the call
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_describe_redescribes_when_newer_frame_arrived() -> None:
    """
    purpose: If _latest_received_frame changes during a _describe() call (simulating
             a new frame arriving while Gemini is in-flight), _describe should schedule
             a second Gemini call for the newer frame after completing the first.
    """
    first_frame = b"\xff\xd8\x01"
    second_frame = b"\xff\xd8\x02"
    describer, mock_client = _make_describer()

    original_call_gemini = describer._call_gemini

    async def _simulate_new_frame_during_call(frame_bytes: bytes) -> str:
        """
        purpose: Intercept the first Gemini call to inject a newer frame mid-flight.
        @param frame_bytes: (bytes) The frame being described.
        @return: (str) Original Gemini mock response.
        """
        if frame_bytes is first_frame:
            # Simulate a new frame arriving while this describe is running
            describer._latest_received_frame = second_frame
        return await original_call_gemini(frame_bytes)

    describer._call_gemini = _simulate_new_frame_during_call  # type: ignore[assignment]

    await describer._describe(first_frame)
    # The re-describe is scheduled via asyncio.create_task; let it run
    await asyncio.sleep(0)

    assert mock_client.aio.models.generate_content.call_count == 2, (
        "Gemini should be called twice: once for the original frame, once for the newer frame"
    )
    assert describer._last_described_frame is second_frame
