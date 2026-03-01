# vision_agent.py
# Purpose: Vision-enabled handoff agent for Sunny screen-sharing sessions (SCREEN-4).
# When the user shares their iOS screen, entrypoint() hands off from the voice-only
# Assistant to VisionAssistant. VisionAssistant uses GPT-4o (vision-capable LLM) and
# injects the latest changed screen frame into every user turn via on_user_turn_completed,
# so the model can see what the user sees and give spatially precise guidance.
#
# On each LLM turn, on_user_turn_completed:
#   1. Calls ScreenCapture.consume_frame_bytes() to retrieve the latest changed JPEG frame.
#   2. If a frame is available, base64-encodes it and appends an ImageContent item.
#   3. Appends a text context block: either the active workflow step or a freeform hint.
#   4. If no new frame exists (screen unchanged), nothing is appended — the LLM reasons
#      from conversation context alone.
#
# Workflow state survives handoffs because both agents share the same WorkflowEngine
# reference, which owns _active_state (SCREEN-4, agent.py Step 1).
#
# Privacy note: VISION_SYSTEM_PROMPT instructs the model not to read or narrate sensitive
# data (passwords, financial details) visible on screen.
#
# Last modified: 2026-02-28

import base64
import logging

from livekit.agents.llm import ChatContext, ChatMessage, ImageContent
from livekit.plugins import openai
from supabase import AsyncClient

from agent import Assistant
from config import VISION_LLM_MODEL
from screen_capture import ScreenCapture
from workflow_engine import WorkflowEngine

logger = logging.getLogger("vision_agent")

VISION_SYSTEM_PROMPT = """\
You are Sunny, a warm and patient voice assistant helping an older adult navigate their iPhone while you can see their screen.

SPATIAL LANGUAGE: Use clear directional terms — "top left," "bottom of the screen," "the blue button in the center," "tap the icon at the top right corner."

PACING: Give one step at a time. After each instruction, wait for the user to confirm before continuing. Never rush through multiple steps at once.

VISUAL CONFIRMATION: Before giving instructions, briefly describe what you see on the screen so the user knows you're looking at the same thing. For example: "I can see the Settings app is open."

WORKFLOW GUIDANCE: When a structured step-by-step workflow is active, you will receive the expected step and visual cue alongside the screenshot. Validate that the screen matches the expected state. If it matches, deliver the step instruction. If it does not match, gently describe what you see and guide the user back to the correct screen before continuing.

IMPROVISED GUIDANCE: When no workflow is active, analyze the screen and help the user with whatever they are working on. Identify the app and the available actions visible on screen.

WRONG SCREEN: If the user is on a different screen than expected, say something like: "It looks like you're on a different screen right now — I can see [describe screen]. Let's get back on track." Then give clear instructions to navigate to the right place.

PRIVACY: If you see a password field, banking details, private messages, or other sensitive information, do not read it aloud or include it in your response. You may acknowledge the field type (e.g., "I can see a password field") but never narrate the content.

TONE: Stay calm, encouraging, and brief. Older adults may feel anxious about technology — reassure them that mistakes are easy to fix and that you are right there with them.
"""


class VisionAssistant(Assistant):
    """
    purpose: Vision-enabled agent that replaces the voice-only Assistant when screen sharing
             is active. Uses GPT-4o as the LLM (vision-capable) and injects the latest
             changed screen frame into every user turn so the model can see the user's screen.
             Inherits all @function_tool methods from Assistant (workflow, reminders, search, etc.).
             Workflow state is preserved across handoffs via the shared WorkflowEngine.
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
        purpose: Initialize VisionAssistant with the VISION_SYSTEM_PROMPT and GPT-4o LLM.
                 All other parameters are forwarded to Assistant.__init__. The llm keyword
                 argument overrides the session-level LLM so GPT-4o is used for this agent.
        @param user_id: (str) UUID of the current user.
        @param supabase: (AsyncClient) Authenticated Supabase async client.
        @param engine: (WorkflowEngine) Shared workflow engine instance (owns active state).
        @param ios_version: (str) User's iOS major version string, e.g. "18".
        @param user_timezone: (str) IANA timezone from the user's profile.
        @param screen_capture: (ScreenCapture | None) Active screen capture instance.
        """
        super().__init__(
            instructions=VISION_SYSTEM_PROMPT,
            llm=openai.LLM(model=VISION_LLM_MODEL),
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
                 Also appends a text context block: the active workflow step details when a
                 workflow is running, or a freeform guidance hint when no workflow is active.
        @param turn_ctx: (ChatContext) The current chat context.
        @param new_message: (ChatMessage) The user message about to be sent to the LLM.
                            Content items are appended in-place.
        """
        frame_bytes = (
            self._screen_capture.consume_frame_bytes() if self._screen_capture else None
        )

        # Inject the latest changed frame, if one is available
        if frame_bytes:
            b64 = base64.b64encode(frame_bytes).decode("ascii")
            new_message.content.append(
                ImageContent(
                    image=f"data:image/jpeg;base64,{b64}", mime_type="image/jpeg"
                )
            )

        # Always inject workflow context so the LLM knows step state even when the
        # screen has not changed since the last turn
        active = self._engine.get_active_state()
        if active:
            step = active.step_map[active.step_ids[active.current_index]]
            if frame_bytes:
                validation_note = (
                    "Validate the screenshot matches this step. If it does, give the "
                    "instruction. If it does not, describe what you see and guide the "
                    "user to the correct screen."
                )
            else:
                validation_note = (
                    "No new screenshot is available — the screen has not changed. "
                    "Repeat or clarify the current step instruction."
                )
            ctx_text = (
                f"[ACTIVE WORKFLOW — Step {active.current_index + 1} of "
                f"{len(active.step_ids)} in '{active.workflow_title}': "
                f"{step.instruction}. Expected visual cue: {step.visual_cue}. "
                f"{validation_note}]"
            )
            new_message.content.append(ctx_text)
        elif frame_bytes:
            # Only inject freeform hint when there is a frame to reason about
            new_message.content.append(
                "[NO WORKFLOW ACTIVE — Analyze the screen content and help the user with "
                "whatever they are trying to do. Identify the app and available actions.]"
            )
