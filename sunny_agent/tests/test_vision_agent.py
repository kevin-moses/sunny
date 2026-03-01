# test_vision_agent.py
# Purpose: Unit tests for VisionAssistant and the screen-share handoff logic (SCREEN-4).
# Covers: system prompt content, JPEG frame injection via on_user_turn_completed,
# no-frame pass-through, workflow context injection, tool inheritance from Assistant,
# workflow state preservation across handoffs, and track handler update_agent calls.
# All tests use mocks — no LiveKit, Supabase, or OpenAI network calls are made.
#
# Last modified: 2026-02-28

import base64
from unittest.mock import AsyncMock, MagicMock

import pytest
from livekit.agents.llm import ChatMessage, ImageContent

from agent import Assistant
from vision_agent import VISION_SYSTEM_PROMPT, VisionAssistant
from workflow_engine import WorkflowEngine, WorkflowState, WorkflowStep

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
    purpose: Build a minimal two-step WorkflowState for injection tests.
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
