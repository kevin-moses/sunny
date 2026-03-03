# vision_agent.py
# Purpose: Vision-enabled handoff agent for Sunny screen-sharing sessions (SCREEN-4/5/6/7).
# When the user shares their iOS screen, entrypoint() hands off from the voice-only
# Assistant to VisionAssistant. VisionAssistant uses Gemini 3 Flash (vision-capable LLM)
# via the LiveKit Google plugin, and injects the latest changed screen frame into every
# user turn via on_user_turn_completed, so the model can see what the user sees and give
# spatially precise guidance.
#
# On each LLM turn, on_user_turn_completed:
#   0. (SCREEN-6) Strips old ImageContent items and stale workflow context strings from
#      previous messages in turn_ctx to keep token count flat (~1.7-2.5K) instead of
#      growing linearly with conversation length.
#   1. Calls ScreenCapture.consume_frame_bytes() to retrieve the latest changed JPEG frame.
#   2. If a frame is available, base64-encodes it and appends an ImageContent item.
#   3. Retrieves step context via engine.get_current_step_context() (or the module-level
#      _FREEFORM_CONTEXT_HINT constant) and appends a text block with validation instructions.
#   4. If no new frame exists (screen unchanged) and a workflow is active, still injects
#      the step context so the LLM knows the current state; no freeform hint is injected.
#
# confirm_step_completed (SCREEN-5): A new @function_tool on VisionAssistant that lets
# the model visually advance the workflow — without waiting for a verbal "I did it" from
# the senior. Delegates to _advance_workflow_step() inherited from Assistant.
#
# SCREEN-7 (proactive-first UX): PACING instruction rewritten to tell the model that
# verbal confirmation is NOT required — the agent watches the screen and auto-advances.
# The separate VISUAL STEP ADVANCEMENT section was merged into PACING to eliminate the
# contradiction between "wait for confirmation" and "advance immediately on visual cue."
#
# Workflow state survives handoffs because both agents share the same WorkflowEngine
# reference, which owns _active_state (SCREEN-4, agent.py Step 1).
#
# Privacy note: VISION_SYSTEM_PROMPT instructs the model not to read or narrate sensitive
# data (passwords, financial details) visible on screen.
#
# Last modified: 2026-03-01

import base64
import logging

from livekit.agents import RunContext
from livekit.agents.llm import ChatContext, ChatMessage, ImageContent, function_tool
from livekit.plugins import google
from supabase import AsyncClient

from agent import Assistant
from config import VISION_LLM_MODEL
from screen_capture import ScreenCapture
from workflow_engine import WorkflowEngine

logger = logging.getLogger("vision_agent")

# Injected when no workflow is active and a frame is present. Instructs the model to
# analyze the screen freely rather than follow a structured step sequence.
_FREEFORM_CONTEXT_HINT = (
    "No structured workflow is active. Analyze the screen content and "
    "help the user with whatever they are trying to do. Identify the app "
    "and available actions visible on screen."
)

# Prefixes for injected context strings — used both when appending (injection) and when
# stripping stale context from previous messages (SCREEN-6). Defined as constants so
# the injection and stripping sites stay in sync.
_ACTIVE_WORKFLOW_PREFIX = "[ACTIVE WORKFLOW"
_NO_WORKFLOW_PREFIX = "[NO WORKFLOW ACTIVE"

VISION_SYSTEM_PROMPT = """\
You are Sunny, a warm and patient voice assistant helping an older adult navigate their iPhone while you can see their screen.

SPATIAL LANGUAGE: Use clear directional terms — "top left," "bottom of the screen," "the blue button in the center," "tap the icon at the top right corner."

PACING: Give one step at a time. Since you can see the screen, you will automatically detect when the user completes each step — they do not need to confirm verbally. After giving an instruction, let the user act. If you see the screen change to match the next step, advance immediately. The user only needs to speak up if they are stuck or cannot find something.

VISUAL CONFIRMATION: Before giving instructions, briefly describe what you see on the screen so the user knows you're looking at the same thing. For example: "I can see the Settings app is open."

WORKFLOW GUIDANCE: When a structured step-by-step workflow is active, you will receive the expected step and visual cue alongside the screenshot. Validate that the screen matches the expected state. If it matches, call confirm_step_completed and deliver the next step instruction. If it does not match, gently describe what you see and guide the user back to the correct screen before continuing.

IMPROVISED GUIDANCE: When no workflow is active, analyze the screen and help the user with whatever they are working on. Identify the app and the available actions visible on screen.

WRONG SCREEN: If the user is on a different screen than expected, say something like: "It looks like you're on a different screen right now — I can see [describe screen]. Let's get back on track." Then give clear instructions to navigate to the right place.

PRIVACY: If you see a password field, banking details, private messages, or other sensitive information, do not read it aloud or include it in your response. You may acknowledge the field type (e.g., "I can see a password field") but never narrate the content.

TONE: Stay calm, encouraging, and brief. Older adults may feel anxious about technology — reassure them that mistakes are easy to fix and that you are right there with them.
"""


class VisionAssistant(Assistant):
    """
    purpose: Vision-enabled agent that replaces the voice-only Assistant when screen sharing
             is active. Uses Gemini 3 Flash as the LLM (vision-capable, via LiveKit Google
             plugin) and injects the latest changed screen frame into every user turn so the
             model can see the user's screen. Inherits all @function_tool methods from
             Assistant (workflow, reminders, search, etc.). Adds confirm_step_completed to
             advance the workflow visually without verbal input. Workflow state is preserved
             across handoffs via the shared WorkflowEngine.
    """

    def __init__(
        self,
        user_id: str,
        supabase: AsyncClient,
        engine: WorkflowEngine,
        ios_version: str,
        user_timezone: str = "America/New_York",
        screen_capture: "ScreenCapture | None" = None,
    ) -> None:
        """
        purpose: Initialize VisionAssistant with the VISION_SYSTEM_PROMPT and Gemini 2.5
                 Flash LLM (via LiveKit Google plugin). All other parameters are forwarded
                 to Assistant.__init__. The llm keyword argument overrides the session-level
                 LLM so Gemini is used for this agent.
        @param user_id: (str) UUID of the current user.
        @param supabase: (AsyncClient) Authenticated Supabase async client.
        @param engine: (WorkflowEngine) Shared workflow engine instance (owns active state).
        @param ios_version: (str) User's iOS major version string, e.g. "18".
        @param user_timezone: (str) IANA timezone from the user's profile.
        @param screen_capture: (ScreenCapture | None) Active screen capture instance.
        """
        super().__init__(
            instructions=VISION_SYSTEM_PROMPT,
            llm=google.LLM(model=VISION_LLM_MODEL),
            user_id=user_id,
            supabase=supabase,
            engine=engine,
            ios_version=ios_version,
            user_timezone=user_timezone,
            screen_capture=screen_capture,
        )

    async def on_user_turn_completed(
        self, turn_ctx: ChatContext, new_message: ChatMessage
    ) -> None:
        """
        purpose: Inject the latest changed screen frame into every user turn before the LLM
                 responds. Base64-encodes the JPEG bytes and appends an ImageContent item to
                 new_message.content. If no changed frame is available (screen content
                 identical since the last turn), nothing is injected and the agent reasons
                 from conversation context alone.
                 Retrieves step context from engine.get_current_step_context() and appends a
                 validation/clarification note. When no workflow is active and a frame is
                 present, appends the module-level _FREEFORM_CONTEXT_HINT constant.
                 (SCREEN-6) Before injecting the new frame, strips old ImageContent items and
                 stale workflow context strings from all previous messages in turn_ctx to keep
                 the token count flat rather than growing linearly with conversation length.
        @param turn_ctx: (ChatContext) The current chat context.
        @param new_message: (ChatMessage) The user message about to be sent to the LLM.
                            Content items are appended in-place.
        """
        # SCREEN-6: Strip old images and stale workflow context from previous messages
        # to keep token count flat (~1.7-2.5K) instead of growing linearly with turns.
        # Guard with isinstance(msg, ChatMessage) because turn_ctx.items may also contain
        # FunctionCall and FunctionCallOutput objects that lack a .content attribute.
        # items[:-1] excludes new_message, which is always the final item in turn_ctx.
        for msg in turn_ctx.items[:-1]:
            if isinstance(msg, ChatMessage) and isinstance(msg.content, list):
                msg.content = [
                    item
                    for item in msg.content
                    if not isinstance(item, ImageContent)
                    and not (
                        isinstance(item, str)
                        and item.startswith(_ACTIVE_WORKFLOW_PREFIX)
                    )
                    and not (
                        isinstance(item, str) and item.startswith(_NO_WORKFLOW_PREFIX)
                    )
                ]

        frame_bytes = (
            self._screen_capture.consume_frame_bytes() if self._screen_capture else None
        )

        if frame_bytes:
            b64 = base64.b64encode(frame_bytes).decode("ascii")
            new_message.content.append(
                ImageContent(
                    image=f"data:image/jpeg;base64,{b64}", mime_type="image/jpeg"
                )
            )

        step_ctx = self._engine.get_current_step_context()
        if step_ctx:
            if frame_bytes:
                validation_note = (
                    "Validate the screenshot matches this step. If it does, give the "
                    "instruction. If it does not, describe what you see and guide the "
                    "user to the correct screen. If the screen shows the step is already "
                    "complete, call confirm_step_completed."
                )
            else:
                validation_note = (
                    "No new screenshot — screen has not changed. "
                    "Repeat or clarify the current step instruction."
                )
            new_message.content.append(
                f"{_ACTIVE_WORKFLOW_PREFIX} — {step_ctx} {validation_note}]"
            )
        elif frame_bytes:
            new_message.content.append(
                f"{_NO_WORKFLOW_PREFIX} — {_FREEFORM_CONTEXT_HINT}]"
            )

    @function_tool
    async def confirm_step_completed(self, context: RunContext) -> str:
        """
        purpose: Advance the workflow to the next step when the screenshot visually
                 confirms the user has completed the current step. Call this when you can
                 see from the screen that the expected state for the current step has been
                 reached — without requiring the user to say so verbally. Delegates to
                 _advance_workflow_step() so the step-advancement logic is not duplicated.
        @param context: (RunContext) LiveKit agent run context (required by @function_tool).
        @return: (str) Step context for the next step, or a completion message.
        """
        return self._advance_workflow_step()
