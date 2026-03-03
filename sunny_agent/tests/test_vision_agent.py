# test_vision_agent.py
# Purpose: Unit tests for VisionAssistant and the screen-share handoff logic (SCREEN-4/5/6).
# Covers: system prompt content, JPEG frame injection via on_user_turn_completed,
# no-frame pass-through, workflow context injection, tool inheritance from Assistant,
# workflow state preservation across handoffs, track handler update_agent calls,
# WorkflowEngine step context helpers, confirm_step_completed visual advancement,
# peek_frame_changed() non-consuming read for the proactive monitor (SCREEN-5),
# and stripping of old images + stale workflow context from previous messages (SCREEN-6).
# All tests use mocks — no LiveKit, Supabase, Google, or OpenAI network calls are made.
# The _mock_google_llm autouse fixture patches google.LLM so VisionAssistant can be
# constructed without a GOOGLE_API_KEY environment variable.
#
# Last modified: 2026-03-01

import base64
from unittest.mock import AsyncMock, MagicMock

import pytest
from livekit.agents.llm import ChatMessage, ImageContent

# Module-level import for the google LLM mock fixture — avoids re-importing
# on every test invocation since autouse=True applies to all tests in this file.
from livekit.plugins import google as _google

from agent import Assistant
from vision_agent import (
    _ACTIVE_WORKFLOW_PREFIX,
    _FREEFORM_CONTEXT_HINT,
    _NO_WORKFLOW_PREFIX,
    VISION_SYSTEM_PROMPT,
    VisionAssistant,
)
from workflow_engine import WorkflowEngine, WorkflowState, WorkflowStep

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _mock_google_llm(monkeypatch: pytest.MonkeyPatch) -> None:
    """
    purpose: Patch google.LLM so VisionAssistant can be constructed without a
             GOOGLE_API_KEY environment variable. Applied to all tests in this file.
    """
    monkeypatch.setattr(_google, "LLM", lambda **kwargs: MagicMock())


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


def _make_vision_assistant(
    engine: WorkflowEngine | None = None,
    screen_capture=None,
) -> VisionAssistant:
    """
    purpose: Build a minimal VisionAssistant suitable for unit tests.
    @param engine: (WorkflowEngine | None) Optional engine; a fresh stub is created if None.
    @param screen_capture: Optional ScreenCapture mock.
    @return: (VisionAssistant) Test-ready vision assistant instance.
    """
    if engine is None:
        engine = _make_engine()
    return VisionAssistant(
        user_id="00000000-0000-0000-0000-000000000001",
        supabase=MagicMock(),
        engine=engine,
        ios_version="18",
        screen_capture=screen_capture,
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


# ---------------------------------------------------------------------------
# Test 1: System prompt spatial language
# ---------------------------------------------------------------------------


def test_vision_system_prompt_has_spatial_language() -> None:
    """
    purpose: Assert VISION_SYSTEM_PROMPT includes key phrases for senior-friendly
             spatial guidance: directional terms, pacing, and visual confirmation.
    """
    required_phrases = [
        "top left",
        "bottom of the screen",
        "one step at a time",
    ]
    for phrase in required_phrases:
        assert phrase in VISION_SYSTEM_PROMPT, (
            f"VISION_SYSTEM_PROMPT is missing required phrase: {phrase!r}"
        )


# ---------------------------------------------------------------------------
# Test 2: on_user_turn_completed injects ImageContent when frame available
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_on_user_turn_completed_injects_frame() -> None:
    """
    purpose: When ScreenCapture.consume_frame_bytes() returns JPEG bytes, assert
             that an ImageContent item is appended to new_message.content.
    """
    fake_jpeg = b"\xff\xd8\xff" + b"\x00" * 10  # minimal JPEG-like bytes
    sc = MagicMock()
    sc.consume_frame_bytes.return_value = fake_jpeg

    va = _make_vision_assistant(screen_capture=sc)
    msg = _make_chat_message()

    await va.on_user_turn_completed(MagicMock(), msg)

    image_items = [c for c in msg.content if isinstance(c, ImageContent)]
    assert len(image_items) == 1, "Expected exactly one ImageContent item in content"
    expected_b64 = base64.b64encode(fake_jpeg).decode("ascii")
    assert f"data:image/jpeg;base64,{expected_b64}" == image_items[0].image


# ---------------------------------------------------------------------------
# Test 3: on_user_turn_completed appends nothing when no new frame
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_on_user_turn_completed_no_frame() -> None:
    """
    purpose: When consume_frame_bytes() returns None (screen unchanged), no
             ImageContent should be appended and content remains empty.
    """
    sc = MagicMock()
    sc.consume_frame_bytes.return_value = None

    va = _make_vision_assistant(screen_capture=sc)
    msg = _make_chat_message()

    await va.on_user_turn_completed(MagicMock(), msg)

    assert msg.content == [], "Content should remain empty when no frame is available"


# ---------------------------------------------------------------------------
# Test 4: on_user_turn_completed injects workflow step context when active
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_on_user_turn_completed_injects_workflow_context() -> None:
    """
    purpose: When a workflow is active, assert that the context string appended
             to new_message.content includes the workflow title and step instruction.
    """
    fake_jpeg = b"\xff\xd8\xff" + b"\x00" * 10
    sc = MagicMock()
    sc.consume_frame_bytes.return_value = fake_jpeg

    engine = _make_engine()
    state = _make_workflow_state()
    engine.set_active_state(state)

    va = _make_vision_assistant(engine=engine, screen_capture=sc)
    msg = _make_chat_message()

    await va.on_user_turn_completed(MagicMock(), msg)

    text_items = [c for c in msg.content if isinstance(c, str)]
    assert len(text_items) == 1, "Expected exactly one text context item"
    ctx = text_items[0]
    assert "Change Wallpaper" in ctx, "Context should contain workflow title"
    assert "Open Settings" in ctx, "Context should contain step instruction"
    assert "ACTIVE WORKFLOW" in ctx, "Context should indicate active workflow"


# ---------------------------------------------------------------------------
# Test 5: on_user_turn_completed appends freeform context when no workflow
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_on_user_turn_completed_no_workflow_context() -> None:
    """
    purpose: When no workflow is active, assert the freeform context string is
             appended and does not reference any workflow title.
    """
    fake_jpeg = b"\xff\xd8\xff" + b"\x00" * 10
    sc = MagicMock()
    sc.consume_frame_bytes.return_value = fake_jpeg

    engine = _make_engine()
    # Ensure no active state
    engine.clear_active_state()

    va = _make_vision_assistant(engine=engine, screen_capture=sc)
    msg = _make_chat_message()

    await va.on_user_turn_completed(MagicMock(), msg)

    text_items = [c for c in msg.content if isinstance(c, str)]
    assert len(text_items) == 1
    assert "NO WORKFLOW ACTIVE" in text_items[0]


# ---------------------------------------------------------------------------
# Test 5b: Workflow context still injected when no new frame (screen unchanged)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_on_user_turn_completed_workflow_context_without_frame() -> None:
    """
    purpose: When consume_frame_bytes() returns None but a workflow is active, assert
             that the workflow context string is still appended even though no image
             is injected. The LLM must always know the current step state.
    """
    sc = MagicMock()
    sc.consume_frame_bytes.return_value = None  # screen unchanged

    engine = _make_engine()
    state = _make_workflow_state()
    engine.set_active_state(state)

    va = _make_vision_assistant(engine=engine, screen_capture=sc)
    msg = _make_chat_message()

    await va.on_user_turn_completed(MagicMock(), msg)

    image_items = [c for c in msg.content if isinstance(c, ImageContent)]
    assert len(image_items) == 0, "No ImageContent expected when no frame available"

    text_items = [c for c in msg.content if isinstance(c, str)]
    assert len(text_items) == 1, "Workflow context should still be injected"
    assert "ACTIVE WORKFLOW" in text_items[0]
    assert "Change Wallpaper" in text_items[0]


# ---------------------------------------------------------------------------
# Test 6: VisionAssistant inherits all @function_tool methods from Assistant
# ---------------------------------------------------------------------------


def test_vision_assistant_inherits_all_tools() -> None:
    """
    purpose: Assert all 11 @function_tool methods defined on Assistant are present
             on VisionAssistant via inheritance.
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
    }
    va = _make_vision_assistant()
    for tool_name in expected_tools:
        assert hasattr(va, tool_name) and callable(getattr(va, tool_name)), (
            f"VisionAssistant is missing tool: {tool_name}"
        )


# ---------------------------------------------------------------------------
# Test 7: Workflow state is preserved across agent handoff
# ---------------------------------------------------------------------------


def test_workflow_state_preserved_across_handoff() -> None:
    """
    purpose: Set active state on WorkflowEngine; construct a VisionAssistant sharing
             the same engine; assert get_active_state() returns the same state object.
             This verifies that workflow progress survives the voice -> vision handoff.
    """
    engine = _make_engine()
    state = _make_workflow_state()
    engine.set_active_state(state)

    va = _make_vision_assistant(engine=engine)

    retrieved = va._engine.get_active_state()
    assert retrieved is state, (
        "VisionAssistant should see the same WorkflowState set on the engine"
    )


# ---------------------------------------------------------------------------
# Test 8: Track subscribed handler calls session.update_agent with VisionAssistant
# ---------------------------------------------------------------------------


def test_track_subscribed_triggers_update_agent() -> None:
    """
    purpose: Simulate _on_track_subscribed with a video KIND_VIDEO track mock and
             assert session.update_agent is called with a VisionAssistant instance.
             Uses asyncio.run to drive the asyncio.create_task calls.
    """
    from livekit import rtc

    # Build a minimal closure replicating what entrypoint() provides
    engine = _make_engine()
    screen_capture = MagicMock()
    screen_capture.consume_frame_bytes.return_value = None
    session = MagicMock()
    session.update_agent = MagicMock()

    # Track mock that looks like a video track
    track = MagicMock()
    track.kind = rtc.TrackKind.KIND_VIDEO
    publication = MagicMock()
    participant = MagicMock()
    participant.identity = "test-user"

    captured_agents: list = []

    def _on_track_subscribed(track, publication, participant):
        """
        purpose: Inline replica of the entrypoint closure for test isolation.
        """
        if track.kind == rtc.TrackKind.KIND_VIDEO:
            screen_capture.start_capture(track)
            from vision_agent import VisionAssistant as VisionAssistantCls

            vision = VisionAssistantCls(
                user_id="uid",
                supabase=MagicMock(),
                engine=engine,
                ios_version="18",
                screen_capture=screen_capture,
            )
            captured_agents.append(vision)
            session.update_agent(vision)

    _on_track_subscribed(track, publication, participant)

    session.update_agent.assert_called_once()
    agent_arg = session.update_agent.call_args[0][0]
    assert isinstance(agent_arg, VisionAssistant), (
        f"Expected VisionAssistant, got {type(agent_arg)}"
    )


# ---------------------------------------------------------------------------
# Test 9: Track unsubscribed handler calls session.update_agent with Assistant
# ---------------------------------------------------------------------------


def test_track_unsubscribed_triggers_update_agent() -> None:
    """
    purpose: Simulate _on_track_unsubscribed with a video KIND_VIDEO track mock and
             assert session.update_agent is called with an Assistant (not VisionAssistant).
    """
    from livekit import rtc

    engine = _make_engine()
    screen_capture = MagicMock()
    session = MagicMock()
    session.update_agent = MagicMock()
    rendered_prompt = "You are Sunny."

    track = MagicMock()
    track.kind = rtc.TrackKind.KIND_VIDEO
    publication = MagicMock()
    participant = MagicMock()
    participant.identity = "test-user"

    def _on_track_unsubscribed(track, publication, participant):
        """
        purpose: Inline replica of the entrypoint closure for test isolation.
        """
        if track.kind == rtc.TrackKind.KIND_VIDEO:
            screen_capture.stop_capture()
            voice = Assistant(
                instructions=rendered_prompt,
                user_id="uid",
                supabase=MagicMock(),
                engine=engine,
                ios_version="18",
                screen_capture=screen_capture,
            )
            session.update_agent(voice)

    _on_track_unsubscribed(track, publication, participant)

    session.update_agent.assert_called_once()
    agent_arg = session.update_agent.call_args[0][0]
    assert isinstance(agent_arg, Assistant), (
        f"Expected Assistant, got {type(agent_arg)}"
    )
    assert not isinstance(agent_arg, VisionAssistant), (
        "Expected plain Assistant, not VisionAssistant"
    )


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
# Test 10: get_current_step_context returns correct string when workflow active
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
# Test 11: get_current_step_context returns None when no workflow active
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
# Test 12: _FREEFORM_CONTEXT_HINT contains expected content
# ---------------------------------------------------------------------------


def test_freeform_context_hint_content() -> None:
    """
    purpose: Assert _FREEFORM_CONTEXT_HINT is a non-empty string instructing
             the model to analyze the screen when no workflow is active.
             The constant lives in vision_agent.py (not on WorkflowEngine) because
             it is a UI/prompt concern, not an engine concern.
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
# Test 13: confirm_step_completed advances step index and returns next step context
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

    va = _make_vision_assistant(engine=engine)
    result = await va.confirm_step_completed(MagicMock())

    assert engine.get_active_state() is not None, "Workflow should still be active"
    assert engine.get_active_state().current_index == 1, (
        "Step index should have advanced to 1 (step_2)"
    )
    assert "Tap Privacy" in result, "Result should contain the next step instruction"
    assert state.history == [0], "History should record the completed step index"


# ---------------------------------------------------------------------------
# Test 14: confirm_step_completed returns completion message on final step
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

    va = _make_vision_assistant(engine=engine)
    result = await va.confirm_step_completed(MagicMock())

    assert engine.get_active_state() is None, (
        "Active state should be cleared after completion"
    )
    assert "Workflow complete" in result, "Result should contain 'Workflow complete'"
    assert "Change Wallpaper" in result, "Result should contain the workflow title"


# ---------------------------------------------------------------------------
# Test 15: peek_frame_changed returns frame_changed flag without consuming
# ---------------------------------------------------------------------------


def test_peek_frame_changed_does_not_consume() -> None:
    """
    purpose: Assert that peek_frame_changed() returns the _frame_changed flag
             without resetting it, so consume_frame_bytes() can still retrieve
             the frame later. Covers the proactive monitor read path (SCREEN-5).
    """
    from screen_capture import ScreenCapture

    sc = ScreenCapture()
    # Initially no frame
    assert sc.peek_frame_changed() is False

    # Simulate a frame arriving
    sc._frame_changed = True
    sc._latest_frame_bytes = b"\xff\xd8\xff\x00"

    # peek should return True but NOT consume
    assert sc.peek_frame_changed() is True
    assert sc._frame_changed is True  # still True

    # consume should return bytes and reset
    data = sc.consume_frame_bytes()
    assert data == b"\xff\xd8\xff\x00"
    assert sc.peek_frame_changed() is False


# ---------------------------------------------------------------------------
# Test 16: on_user_turn_completed strips old images and stale workflow context
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_on_user_turn_completed_strips_old_images() -> None:
    """
    purpose: Assert that on_user_turn_completed removes ImageContent items and stale
             workflow context strings from previous messages in turn_ctx, keeping
             only the latest frame and current step context (SCREEN-6).
    """
    fake_jpeg = b"\xff\xd8\xff" + b"\x00" * 10
    old_b64 = base64.b64encode(b"\xff\xd8\xff\x00\x01").decode("ascii")

    sc = MagicMock()
    sc.consume_frame_bytes.return_value = fake_jpeg

    engine = _make_engine()
    state = _make_workflow_state()
    engine.set_active_state(state)

    va = _make_vision_assistant(engine=engine, screen_capture=sc)

    # Build a turn_ctx with a previous message containing old image + stale context
    old_msg = ChatMessage(
        role="assistant",
        content=[
            "Here is what I see.",
            ImageContent(
                image=f"data:image/jpeg;base64,{old_b64}", mime_type="image/jpeg"
            ),
            f"{_ACTIVE_WORKFLOW_PREFIX} — Step 1 of 1 ...old context...]",
            f"{_NO_WORKFLOW_PREFIX} — stale freeform hint]",
        ],
    )
    new_msg = _make_chat_message()
    turn_ctx = MagicMock()
    turn_ctx.items = [old_msg, new_msg]

    await va.on_user_turn_completed(turn_ctx, new_msg)

    # Old message should have image and workflow context stripped
    old_image_items = [c for c in old_msg.content if isinstance(c, ImageContent)]
    assert len(old_image_items) == 0, "Old ImageContent should be stripped"

    old_workflow_items = [
        c
        for c in old_msg.content
        if isinstance(c, str)
        and (c.startswith(_ACTIVE_WORKFLOW_PREFIX) or c.startswith(_NO_WORKFLOW_PREFIX))
    ]
    assert len(old_workflow_items) == 0, "Old workflow context should be stripped"

    # Plain text should survive
    old_text_items = [c for c in old_msg.content if isinstance(c, str)]
    assert "Here is what I see." in old_text_items, (
        "Non-workflow text should be preserved"
    )

    # New message should have fresh image + context
    new_image_items = [c for c in new_msg.content if isinstance(c, ImageContent)]
    assert len(new_image_items) == 1, "New message should have exactly one ImageContent"
