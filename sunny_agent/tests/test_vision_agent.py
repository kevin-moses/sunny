# test_vision_agent.py
# Purpose: Unit tests for the screen-share vision features of Assistant (SCREEN-8/9).
# Covers: system prompt content, description text injection via on_user_turn_completed
# (fresh/stale/none branches), workflow context injection, refresh_vision tool,
# tool presence on Assistant, workflow state preservation, track handler in-place
# _screen_describer attachment, WorkflowEngine step context helpers,
# confirm_step_completed visual advancement, stripping of old description strings
# from previous messages (SCREEN-6), and set_on_frame_captured callback API (SCREEN-9).
# All tests use mocks — no LiveKit, Supabase, Anthropic, or Google network calls are made.
# The _mock_anthropic_llm autouse fixture patches anthropic.LLM so Assistant can
# be constructed without an ANTHROPIC_API_KEY environment variable.
#
# Last modified: 2026-03-03 (SCREEN-9: test 21 updated to callback API)

import time
from unittest.mock import AsyncMock, MagicMock

import pytest
from livekit.agents.llm import ChatMessage, ImageContent
from livekit.plugins import anthropic as _anthropic

from agent import (
    _FREEFORM_CONTEXT_HINT,
    _SCREEN_DESC_PREFIX,
    Assistant,
)
from prompts import SYSTEM_PROMPT_TEMPLATE
from workflow_engine import WorkflowEngine, WorkflowState, WorkflowStep

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _mock_anthropic_llm(monkeypatch: pytest.MonkeyPatch) -> None:
    """
    purpose: Patch anthropic.LLM so Assistant can be constructed without
             an ANTHROPIC_API_KEY environment variable. Applied to all tests in this file.
    """
    monkeypatch.setattr(_anthropic, "LLM", lambda **kwargs: MagicMock())


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_engine() -> WorkflowEngine:
    """
    purpose: Build a WorkflowEngine with a stub Supabase client for unit tests.
             Patches async network methods so no real calls are made.
    @return: (WorkflowEngine) Test-ready engine instance.
    """
    engine = WorkflowEngine(supabase=MagicMock())
    engine.find_workflow = AsyncMock(return_value=("", "", False))
    engine.resolve_workflow = AsyncMock(return_value=None)
    return engine


def _make_assistant(
    engine: WorkflowEngine | None = None,
    screen_capture=None,
    screen_describer=None,
) -> Assistant:
    """
    purpose: Build a minimal Assistant suitable for unit tests, optionally configured
             with a screen_describer to simulate screen-share mode.
    @param engine: (WorkflowEngine | None) Optional engine; a fresh stub is created if None.
    @param screen_capture: Optional ScreenCapture mock.
    @param screen_describer: Optional ScreenDescriber mock (enables vision mode).
    @return: (Assistant) Test-ready assistant instance.
    """
    if engine is None:
        engine = _make_engine()
    return Assistant(
        instructions="You are Sunny.",
        user_id="00000000-0000-0000-0000-000000000001",
        supabase=MagicMock(),
        engine=engine,
        ios_version="18",
        screen_capture=screen_capture,
        screen_describer=screen_describer,
    )


def _make_chat_message() -> ChatMessage:
    """
    purpose: Build a minimal user ChatMessage with an empty content list.
    @return: (ChatMessage) Test user message.
    """
    return ChatMessage(role="user", content=[])


def _make_workflow_state() -> WorkflowState:
    """
    purpose: Build a minimal single-step WorkflowState for injection tests.
    @return: (WorkflowState) State with one active step.
    """
    step = WorkflowStep(
        step_id="step_1",
        instruction="Open Settings",
        visual_cue="You should see the grey Settings icon",
        confirmation_prompt="Have you opened Settings?",
        success_indicators=["Settings is open"],
        common_issues=[],
        fallback="Try swiping right on the home screen.",
        next_step=None,
    )
    return WorkflowState(
        workflow_id="wf_001",
        workflow_title="Change Wallpaper",
        step_ids=["step_1"],
        step_map={"step_1": step},
        current_index=0,
        history=[],
    )


def _make_screen_describer(description: str | None, last_change: float = 0.0):
    """
    purpose: Build a mock ScreenDescriber with configurable description and describe_now.
    @param description: (str | None) Value returned by get_description().
    @param last_change: (float) Value for last_description_time property.
    @return: MagicMock configured to simulate ScreenDescriber.
    """
    sd = MagicMock()
    sd.get_description.return_value = description
    sd.last_description_time = last_change
    sd.describe_now = AsyncMock(return_value=description or "fresh description")
    return sd


def _make_screen_capture(last_frame_change_time: float = 0.0):
    """
    purpose: Build a mock ScreenCapture with configurable last_frame_change_time.
    @param last_frame_change_time: (float) Monotonic timestamp of last frame change.
    @return: MagicMock configured to simulate ScreenCapture.
    """
    sc = MagicMock()
    sc.last_frame_change_time = last_frame_change_time
    return sc


# ---------------------------------------------------------------------------
# Test 1: System prompt spatial language
# ---------------------------------------------------------------------------


def test_vision_system_prompt_has_spatial_language() -> None:
    """
    purpose: Assert SYSTEM_PROMPT_TEMPLATE includes key phrases for senior-friendly
             spatial guidance, brevity, and vision mode rules.
             These are now in the == VISION MODE == section (SCREEN-8).
    """
    required_phrases = [
        "top left",
        "bottom of the screen",
        "one short sentence",
    ]
    for phrase in required_phrases:
        assert phrase in SYSTEM_PROMPT_TEMPLATE, (
            f"SYSTEM_PROMPT_TEMPLATE is missing required phrase: {phrase!r}"
        )


# ---------------------------------------------------------------------------
# Test 2: System prompt mentions refresh_vision
# ---------------------------------------------------------------------------


def test_vision_system_prompt_has_refresh_vision() -> None:
    """
    purpose: Assert SYSTEM_PROMPT_TEMPLATE includes the REFRESH_VISION section
             instructing the model to call refresh_vision() on stale/unavailable
             descriptions (in the == VISION MODE == section, SCREEN-8).
    """
    assert "refresh_vision" in SYSTEM_PROMPT_TEMPLATE, (
        "SYSTEM_PROMPT_TEMPLATE must mention refresh_vision tool"
    )
    assert (
        "stale" in SYSTEM_PROMPT_TEMPLATE.lower()
        or "possibly stale" in SYSTEM_PROMPT_TEMPLATE
    ), "SYSTEM_PROMPT_TEMPLATE must address stale description case"


# ---------------------------------------------------------------------------
# Test 3: on_user_turn_completed injects fresh description text
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_on_user_turn_completed_injects_fresh_description() -> None:
    """
    purpose: When ScreenDescriber has a description and screen has not changed recently,
             assert that a fresh description text block is injected into new_message.content.
    """
    now = time.monotonic()
    sd = _make_screen_describer("App: Settings | Screen: Main", last_change=now - 10)
    sc = _make_screen_capture(last_frame_change_time=now - 10)

    assistant = _make_assistant(screen_capture=sc, screen_describer=sd)
    msg = _make_chat_message()

    await assistant.on_user_turn_completed(MagicMock(), msg)

    text_items = [c for c in msg.content if isinstance(c, str)]
    assert any(_SCREEN_DESC_PREFIX in item for item in text_items), (
        "Expected a SCREEN DESCRIPTION block in content"
    )
    # Fresh: should NOT contain "possibly stale"
    desc_item = next(c for c in text_items if _SCREEN_DESC_PREFIX in c)
    assert "possibly stale" not in desc_item, (
        "Fresh description should not be marked stale"
    )
    assert "App: Settings" in desc_item, "Description text should be included"


# ---------------------------------------------------------------------------
# Test 4: on_user_turn_completed injects stale marker when screen changed recently
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_on_user_turn_completed_injects_stale_marker() -> None:
    """
    purpose: When the screen changed very recently (< SCREEN_STALE_THRESHOLD_S),
             assert that the description block is marked 'possibly stale' and contains
             the hint to call refresh_vision.
    """
    now = time.monotonic()
    # Screen changed 0.5s ago — within SCREEN_STALE_THRESHOLD_S (1.5s)
    sd = _make_screen_describer("App: Settings | Screen: Main", last_change=now - 5)
    sc = _make_screen_capture(last_frame_change_time=now - 0.5)

    assistant = _make_assistant(screen_capture=sc, screen_describer=sd)
    msg = _make_chat_message()

    await assistant.on_user_turn_completed(MagicMock(), msg)

    text_items = [c for c in msg.content if isinstance(c, str)]
    desc_item = next((c for c in text_items if _SCREEN_DESC_PREFIX in c), None)
    assert desc_item is not None, "Expected a SCREEN DESCRIPTION block"
    assert "possibly stale" in desc_item, "Block should be marked 'possibly stale'"
    assert "refresh_vision" in desc_item, "Block should hint to call refresh_vision"


# ---------------------------------------------------------------------------
# Test 5: on_user_turn_completed injects cold-start placeholder when no description
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_on_user_turn_completed_no_description_placeholder() -> None:
    """
    purpose: When ScreenDescriber.get_description() returns None (cold start),
             assert that a 'not yet available' placeholder is injected so the model
             knows to ask the user to wait.
    """
    sd = _make_screen_describer(None)
    sc = _make_screen_capture(last_frame_change_time=0.0)

    assistant = _make_assistant(screen_capture=sc, screen_describer=sd)
    msg = _make_chat_message()

    await assistant.on_user_turn_completed(MagicMock(), msg)

    text_items = [c for c in msg.content if isinstance(c, str)]
    desc_item = next((c for c in text_items if _SCREEN_DESC_PREFIX in c), None)
    assert desc_item is not None, "Expected a SCREEN DESCRIPTION placeholder"
    assert "not yet available" in desc_item, (
        "Placeholder should say 'not yet available'"
    )


# ---------------------------------------------------------------------------
# Test 6: on_user_turn_completed injects workflow context when active
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_on_user_turn_completed_injects_workflow_context() -> None:
    """
    purpose: When a workflow is active, assert that the context string appended
             to new_message.content includes the workflow title and step instruction.
    """
    now = time.monotonic()
    sd = _make_screen_describer("App: Settings | Screen: Main", last_change=now - 10)
    sc = _make_screen_capture(last_frame_change_time=now - 10)

    engine = _make_engine()
    state = _make_workflow_state()
    engine.set_active_state(state)

    assistant = _make_assistant(engine=engine, screen_capture=sc, screen_describer=sd)
    msg = _make_chat_message()

    await assistant.on_user_turn_completed(MagicMock(), msg)

    text_items = [c for c in msg.content if isinstance(c, str)]
    workflow_item = next((c for c in text_items if "ACTIVE WORKFLOW" in c), None)
    assert workflow_item is not None, "Expected ACTIVE WORKFLOW context item"
    assert "Change Wallpaper" in workflow_item, "Context should contain workflow title"
    assert "Open Settings" in workflow_item, "Context should contain step instruction"


# ---------------------------------------------------------------------------
# Test 7: on_user_turn_completed appends freeform context when no workflow
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_on_user_turn_completed_no_workflow_freeform() -> None:
    """
    purpose: When no workflow is active and a description is available, assert the
             freeform context string is appended and does not reference any workflow title.
    """
    now = time.monotonic()
    sd = _make_screen_describer(
        "App: Camera | Screen: Viewfinder", last_change=now - 10
    )
    sc = _make_screen_capture(last_frame_change_time=now - 10)

    engine = _make_engine()
    engine.clear_active_state()

    assistant = _make_assistant(engine=engine, screen_capture=sc, screen_describer=sd)
    msg = _make_chat_message()

    await assistant.on_user_turn_completed(MagicMock(), msg)

    text_items = [c for c in msg.content if isinstance(c, str)]
    freeform_item = next((c for c in text_items if "NO WORKFLOW ACTIVE" in c), None)
    assert freeform_item is not None, "Expected NO WORKFLOW ACTIVE freeform item"


# ---------------------------------------------------------------------------
# Test 8: on_user_turn_completed no freeform when no description + no workflow
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_on_user_turn_completed_no_freeform_when_no_description() -> None:
    """
    purpose: When no workflow is active and no description is available (cold start),
             assert that the freeform context item is NOT appended — only the placeholder.
    """
    sd = _make_screen_describer(None)
    sc = _make_screen_capture(last_frame_change_time=0.0)

    engine = _make_engine()
    engine.clear_active_state()

    assistant = _make_assistant(engine=engine, screen_capture=sc, screen_describer=sd)
    msg = _make_chat_message()

    await assistant.on_user_turn_completed(MagicMock(), msg)

    text_items = [c for c in msg.content if isinstance(c, str)]
    freeform_item = next((c for c in text_items if "NO WORKFLOW ACTIVE" in c), None)
    assert freeform_item is None, (
        "No freeform context should be added when description is unavailable"
    )


# ---------------------------------------------------------------------------
# Test 9: refresh_vision calls describe_now for a fresh description
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_refresh_vision_calls_describe_now() -> None:
    """
    purpose: Assert that calling refresh_vision() calls describe_now() on the
             ScreenDescriber to get a fresh description (not the stale cache).
    """
    sd = _make_screen_describer("App: Maps | Screen: Route", last_change=0.0)
    sd.describe_now = AsyncMock(return_value="App: Maps | Screen: Route")

    assistant = _make_assistant(screen_describer=sd)
    result = await assistant.refresh_vision(MagicMock())

    sd.describe_now.assert_awaited_once()
    assert "Maps" in result
    assert "Fresh view" in result


# ---------------------------------------------------------------------------
# Test 10: refresh_vision with no describer returns fallback
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_refresh_vision_no_describer_returns_fallback() -> None:
    """
    purpose: When screen_describer is None, refresh_vision() should return a
             safe fallback string rather than raising an exception.
    """
    assistant = _make_assistant(screen_describer=None)
    result = await assistant.refresh_vision(MagicMock())

    assert isinstance(result, str), "Should return a string"
    assert len(result) > 0, "Should return a non-empty fallback"


# ---------------------------------------------------------------------------
# Test 11: Assistant has refresh_vision and confirm_step_completed tools
# ---------------------------------------------------------------------------


def test_assistant_has_vision_tools() -> None:
    """
    purpose: Assert Assistant exposes the refresh_vision and confirm_step_completed
             tools added in SCREEN-8 and SCREEN-5 (now on base class, not VisionAssistant).
    """
    assistant = _make_assistant()
    assert hasattr(assistant, "refresh_vision") and callable(assistant.refresh_vision)
    assert hasattr(assistant, "confirm_step_completed") and callable(
        assistant.confirm_step_completed
    )


# ---------------------------------------------------------------------------
# Test 12: Assistant inherits all @function_tool methods
# ---------------------------------------------------------------------------


def test_assistant_has_all_tools() -> None:
    """
    purpose: Assert all expected @function_tool methods are present on Assistant.
    """
    expected_tools = {
        "web_search",
        "create_reminder",
        "find_contact",
        "send_message",
        "save_reminder",
        "list_reminders",
        "delete_reminder",
        "start_workflow",
        "confirm_step",
        "go_back_step",
        "exit_workflow",
        "refresh_vision",
        "confirm_step_completed",
    }
    assistant = _make_assistant()
    for tool_name in expected_tools:
        assert hasattr(assistant, tool_name) and callable(
            getattr(assistant, tool_name)
        ), f"Assistant is missing tool: {tool_name}"


# ---------------------------------------------------------------------------
# Test 13: Workflow state is preserved when screen_describer is set in-place
# ---------------------------------------------------------------------------


def test_workflow_state_preserved_when_describer_set_in_place() -> None:
    """
    purpose: Set active state on WorkflowEngine; construct an Assistant sharing
             the same engine; set _screen_describer in-place; assert get_active_state()
             returns the same state object. Verifies workflow progress survives the
             in-place _screen_describer attachment (SCREEN-8).
    """
    engine = _make_engine()
    state = _make_workflow_state()
    engine.set_active_state(state)

    assistant = _make_assistant(engine=engine)
    sd = MagicMock()
    assistant._screen_describer = sd

    retrieved = assistant._engine.get_active_state()
    assert retrieved is state, (
        "Workflow state should be preserved after _screen_describer is set in-place"
    )


# ---------------------------------------------------------------------------
# Test 14: Track subscribed attaches screen_describer in-place
# ---------------------------------------------------------------------------


def test_track_subscribed_attaches_screen_describer() -> None:
    """
    purpose: Simulate _on_track_subscribed by directly setting assistant._screen_describer
             and assert it is no longer None. Verifies the in-place attachment approach
             (SCREEN-8: no session.update_agent needed).
    """
    from screen_describer import ScreenDescriber as ScreenDescriberCls

    engine = _make_engine()
    assistant = _make_assistant(engine=engine)
    assert assistant._screen_describer is None

    sd = MagicMock(spec=ScreenDescriberCls)
    assistant._screen_describer = sd

    assert assistant._screen_describer is not None
    assert assistant._screen_describer is sd


# ---------------------------------------------------------------------------
# Test 15: Track unsubscribed clears screen_describer in-place
# ---------------------------------------------------------------------------


def test_track_unsubscribed_clears_screen_describer() -> None:
    """
    purpose: Simulate _on_track_unsubscribed by clearing assistant._screen_describer
             and assert it becomes None. Verifies the in-place clear approach
             (SCREEN-8: no session.update_agent needed).
    """
    from screen_describer import ScreenDescriber as ScreenDescriberCls

    engine = _make_engine()
    assistant = _make_assistant(engine=engine)
    assistant._screen_describer = MagicMock(spec=ScreenDescriberCls)
    assert assistant._screen_describer is not None

    assistant._screen_describer = None

    assert assistant._screen_describer is None


# ---------------------------------------------------------------------------
# Helpers for SCREEN-5 tests
# ---------------------------------------------------------------------------


def _make_two_step_workflow_state() -> WorkflowState:
    """
    purpose: Build a two-step WorkflowState for confirm_step_completed advancement tests.
    @return: (WorkflowState) State with step_1 active and step_2 as the next step.
    """
    step_1 = WorkflowStep(
        step_id="step_1",
        instruction="Open Settings",
        visual_cue="You should see the grey Settings icon",
        confirmation_prompt="Have you opened Settings?",
        success_indicators=["Settings is open"],
        common_issues=[],
        fallback="Try swiping right on the home screen.",
        next_step="step_2",
    )
    step_2 = WorkflowStep(
        step_id="step_2",
        instruction="Tap Privacy",
        visual_cue="You should see Privacy in the list",
        confirmation_prompt="Do you see Privacy?",
        success_indicators=["Privacy is visible"],
        common_issues=[],
        fallback="Scroll down to find Privacy.",
        next_step=None,
    )
    return WorkflowState(
        workflow_id="wf_002",
        workflow_title="Enable Location",
        step_ids=["step_1", "step_2"],
        step_map={"step_1": step_1, "step_2": step_2},
        current_index=0,
        history=[],
    )


# ---------------------------------------------------------------------------
# Test 16: get_current_step_context returns correct string when workflow active
# ---------------------------------------------------------------------------


def test_get_current_step_context_with_active_workflow() -> None:
    """
    purpose: Set an active WorkflowState on the engine and assert that
             get_current_step_context() returns a formatted string containing
             the step number, workflow title, instruction, and visual cue.
    """
    engine = _make_engine()
    state = _make_workflow_state()
    engine.set_active_state(state)

    ctx = engine.get_current_step_context()

    assert ctx is not None, "Expected a context string, got None"
    assert "Step 1 of 1" in ctx, "Context should contain step number"
    assert "Change Wallpaper" in ctx, "Context should contain workflow title"
    assert "Open Settings" in ctx, "Context should contain step instruction"
    assert "You should see the grey Settings icon" in ctx, (
        "Context should contain visual cue"
    )


# ---------------------------------------------------------------------------
# Test 17: get_current_step_context returns None when no workflow active
# ---------------------------------------------------------------------------


def test_get_current_step_context_no_active_workflow() -> None:
    """
    purpose: Assert get_current_step_context() returns None when no workflow
             is active on the engine.
    """
    engine = _make_engine()
    engine.clear_active_state()

    ctx = engine.get_current_step_context()

    assert ctx is None, f"Expected None when no workflow active, got: {ctx!r}"


# ---------------------------------------------------------------------------
# Test 18: _FREEFORM_CONTEXT_HINT contains expected content
# ---------------------------------------------------------------------------


def test_freeform_context_hint_content() -> None:
    """
    purpose: Assert _FREEFORM_CONTEXT_HINT is a non-empty string instructing
             the model to analyze the screen when no workflow is active.
    """
    assert (
        isinstance(_FREEFORM_CONTEXT_HINT, str) and len(_FREEFORM_CONTEXT_HINT) > 0
    ), "Expected a non-empty hint string"
    assert "No structured workflow" in _FREEFORM_CONTEXT_HINT, (
        "Hint should mention no workflow is active"
    )
    assert "Analyze" in _FREEFORM_CONTEXT_HINT, (
        "Hint should instruct the model to analyze the screen"
    )


# ---------------------------------------------------------------------------
# Test 19: confirm_step_completed advances step index and returns next step context
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_confirm_step_completed_advances_step() -> None:
    """
    purpose: With a two-step workflow active on the engine, call confirm_step_completed
             and assert the active state advances to step 2, with the return value
             containing step 2 content.
    """
    engine = _make_engine()
    state = _make_two_step_workflow_state()
    engine.set_active_state(state)

    assistant = _make_assistant(engine=engine)
    result = await assistant.confirm_step_completed(MagicMock())

    assert engine.get_active_state() is not None, "Workflow should still be active"
    assert engine.get_active_state().current_index == 1, (
        "Step index should have advanced to 1 (step_2)"
    )
    assert "Tap Privacy" in result, "Result should contain the next step instruction"
    assert state.history == [0], "History should record the completed step index"


# ---------------------------------------------------------------------------
# Test 20: confirm_step_completed returns completion message on final step
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_confirm_step_completed_on_final_step() -> None:
    """
    purpose: With a single-step (final) workflow active, call confirm_step_completed
             and assert the active state is cleared and the return value contains
             the completion message with the workflow title.
    """
    engine = _make_engine()
    state = _make_workflow_state()  # single step, next_step=None
    engine.set_active_state(state)

    assistant = _make_assistant(engine=engine)
    result = await assistant.confirm_step_completed(MagicMock())

    assert engine.get_active_state() is None, (
        "Active state should be cleared after completion"
    )
    assert "Workflow complete" in result, "Result should contain 'Workflow complete'"
    assert "Change Wallpaper" in result, "Result should contain the workflow title"


# ---------------------------------------------------------------------------
# Test 21: set_on_frame_captured wires and clears callback (SCREEN-9)
# ---------------------------------------------------------------------------


def test_set_on_frame_captured_wires_callback() -> None:
    """
    purpose: set_on_frame_captured registers a callable on ScreenCapture. Clearing
             it with None should not raise. Verifies callback API introduced in SCREEN-9.
    """
    from screen_capture import ScreenCapture

    sc = ScreenCapture()
    assert sc.last_frame_change_time == 0.0
    sc.set_on_frame_captured(lambda b: None)
    sc.set_on_frame_captured(None)


# ---------------------------------------------------------------------------
# Test 22: last_frame_change_time updates when frame is consumed
# ---------------------------------------------------------------------------


def test_last_frame_change_time_initialized_to_zero() -> None:
    """
    purpose: Assert that ScreenCapture.last_frame_change_time starts at 0.0
             (no frame yet) and is exposed as a property.
    """
    from screen_capture import ScreenCapture

    sc = ScreenCapture()
    assert sc.last_frame_change_time == 0.0


# ---------------------------------------------------------------------------
# Test 23: on_user_turn_completed strips old SCREEN DESCRIPTION strings
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_on_user_turn_completed_strips_old_descriptions() -> None:
    """
    purpose: Assert that on_user_turn_completed removes [SCREEN DESCRIPTION...
             prefix strings and ImageContent items from previous messages in turn_ctx,
             keeping only the latest description (SCREEN-6).
    """
    now = time.monotonic()
    sd = _make_screen_describer("App: Settings | Screen: Main", last_change=now - 10)
    sc = _make_screen_capture(last_frame_change_time=now - 10)

    engine = _make_engine()
    state = _make_workflow_state()
    engine.set_active_state(state)

    assistant = _make_assistant(engine=engine, screen_capture=sc, screen_describer=sd)

    old_msg = ChatMessage(
        role="assistant",
        content=[
            "Here is what I see.",
            ImageContent(image="data:image/jpeg;base64,abc123", mime_type="image/jpeg"),
            f"{_SCREEN_DESC_PREFIX} - captured 3.2s ago]\nApp: Home | Screen: Home",
        ],
    )
    new_msg = _make_chat_message()
    turn_ctx = MagicMock()
    turn_ctx.items = [old_msg, new_msg]

    await assistant.on_user_turn_completed(turn_ctx, new_msg)

    # Old ImageContent should be stripped
    old_image_items = [c for c in old_msg.content if isinstance(c, ImageContent)]
    assert len(old_image_items) == 0, "Old ImageContent should be stripped"

    # Old description strings should be stripped
    old_desc_items = [
        c
        for c in old_msg.content
        if isinstance(c, str) and c.startswith(_SCREEN_DESC_PREFIX)
    ]
    assert len(old_desc_items) == 0, "Old description strings should be stripped"

    # Plain text should survive
    old_text_items = [
        c for c in old_msg.content if isinstance(c, str) and not c.startswith("[")
    ]
    assert "Here is what I see." in old_text_items, (
        "Non-description text should be preserved"
    )

    # New message should have fresh description
    new_desc_items = [
        c for c in new_msg.content if isinstance(c, str) and _SCREEN_DESC_PREFIX in c
    ]
    assert len(new_desc_items) == 1, (
        "New message should have exactly one description block"
    )


# ---------------------------------------------------------------------------
# Test 24: Screen-share UX tools return active message when sharing (SCREEN-8)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_screen_share_ux_tools_return_active_message_when_sharing() -> None:
    """
    purpose: Assert that suggest_screen_share and guide_screen_share_start return
             "Screen sharing is already active." when _screen_describer is not None.
             These tools stay in the tool list (unlike the old VisionAssistant override),
             but return a safe no-op string so the LLM cannot cause spurious behavior (SCREEN-8).
    """
    sd = _make_screen_describer("App: Settings", last_change=0.0)
    assistant = _make_assistant(screen_describer=sd)

    result_suggest = await assistant.suggest_screen_share(MagicMock())
    assert result_suggest == "Screen sharing is already active.", (
        "suggest_screen_share must return early when screen sharing is active"
    )

    result_guide = await assistant.guide_screen_share_start(MagicMock())
    assert result_guide == "Screen sharing is already active.", (
        "guide_screen_share_start must return early when screen sharing is active"
    )


# ---------------------------------------------------------------------------
# Test 25: on_user_turn_completed is a no-op without screen_describer
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_on_user_turn_completed_noop_without_describer() -> None:
    """
    purpose: When _screen_describer is None (voice-only mode), on_user_turn_completed
             should return immediately without appending anything to new_message.content.
    """
    assistant = _make_assistant(screen_describer=None)
    msg = _make_chat_message()
    await assistant.on_user_turn_completed(MagicMock(), msg)
    assert msg.content == [], "Voice-only mode: no content should be injected"
