# screen_describer.py
# Purpose: Background Gemini screen describer for the Sunny hybrid vision router.
# ScreenDescriber receives frames from ScreenCapture via the on_frame_captured callback
# (SCREEN-9: event-driven, replacing the poll loop). When a new frame arrives,
# on_frame_captured() always stores it and — if not rate-limited and no describe is
# in flight — kicks off an asyncio.create_task(_describe()) immediately.
#
# Architecture:
#   - Gemini runs ONLY in the background, never on the hot path of a user turn.
#   - Assistant (Claude Haiku) handles all conversational turns (0.4-0.6s TTFT).
#   - When the screen changes recently (< SCREEN_STALE_THRESHOLD_S), Assistant calls
#     refresh_vision() which reads the cached description — this acquires _describe_lock,
#     so if a background describe is in flight it waits for that result instead of
#     issuing a duplicate Gemini call.
#   - Rate limiting (DESCRIBE_RATE_LIMIT_S) prevents scroll bursts from spamming
#     Gemini — at most one background describe every 2s.
#   - _latest_received_frame always holds the newest accepted frame for describe_now().
#
# Gemini prompt outputs JSON with this schema:
#   { "current_app", "current_screen", "notable_elements": [...],
#     "target_visible", "target_description", "target_position",
#     "step_complete", "unexpected_elements" }
# _json_to_text() converts this to a human-readable text block injected into context.
#
# on_description_ready callback: called after each successful background describe.
# agent.py wires this to trigger session.generate_reply() when a workflow is active
# and the agent is in listening state (proactive monitor).
#
# Re-describe after in-flight: _describe() now tracks _last_described_frame. After the
# Gemini call completes, if _latest_received_frame differs (a newer frame arrived during
# the call), another _describe() is scheduled immediately — closing the latency gap
# where the screen changes during a Gemini call and the new frame never gets described.
#
# Last modified: 2026-03-03

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from collections.abc import Callable

import google.genai as genai

from config import DESCRIBE_LLM_MODEL, DESCRIBE_NOW_CACHE_FRESH_S, DESCRIBE_RATE_LIMIT_S
from screen_capture import ScreenCapture
from workflow_engine import WorkflowEngine

logger = logging.getLogger("screen_describer")

_FENCE_RE = re.compile(r"^```(?:json)?\s*|\s*```$")

_DESCRIBE_PROMPT_BASE = """\
Analyze this iOS screenshot and output JSON matching this exact schema:
{
  "current_app": "...",
  "current_screen": "...",
  "notable_elements": [{"label": "...", "position": "...", "state": "..."}],
  "target_visible": true|false|null,
  "target_description": "...",
  "target_position": "...",
  "step_complete": true|false|null,
  "unexpected_elements": ["..."]
}
target_visible and step_complete are null when no workflow is active.
Include ALL tappable/visible UI elements in notable_elements with label, position (e.g. "top left", "row 3", "bottom center"), and state (e.g. "enabled", "selected", "dimmed").
Output only valid JSON, no markdown code fences."""

_DESCRIBE_PROMPT_WITH_STEP = """\
{base}

Current workflow step context:
{step_ctx}

Use target_visible/target_description/target_position/step_complete to reflect whether the expected UI element for this step is visible and whether the step appears complete."""


class ScreenDescriber:
    """
    purpose: Background Gemini screen describer for the Sunny hybrid vision router.
             Receives frames from ScreenCapture via the on_frame_captured callback
             (SCREEN-9: event-driven push, replaces the poll loop). Each new frame is
             stored immediately; a background Gemini describe is kicked off if neither
             rate-limited (DESCRIBE_RATE_LIMIT_S) nor already in flight (_describing).
             After a describe completes, if a newer frame arrived during the call,
             another describe is scheduled immediately (re-describe logic).
             Assistant reads the cached description text block on each user turn.
    """

    def __init__(self, screen_capture: ScreenCapture, engine: WorkflowEngine) -> None:
        """
        purpose: Initialize ScreenDescriber with screen capture and workflow engine refs.
                 No Gemini calls are made until start() is called.
        @param screen_capture: (ScreenCapture) Active screen capture providing frames.
        @param engine: (WorkflowEngine) Shared workflow engine for step context injection.
        """
        self._screen_capture = screen_capture
        self._engine = engine
        self._latest_description_text: str | None = None
        self._latest_received_frame: bytes | None = None
        self._last_description_time: float = 0.0
        self._last_describe_time: float = 0.0
        self._describing: bool = False
        self._last_described_frame: bytes | None = None
        self._stopped: bool = False
        self._describe_lock: asyncio.Lock = asyncio.Lock()
        self._on_description_ready: Callable[[str], None] | None = None
        self._genai_client = genai.Client()

    def set_on_description_ready(self, callback: Callable[[str], None]) -> None:
        """
        purpose: Register a callback invoked after each successful background Gemini
                 description. agent.py wires this to trigger session.generate_reply()
                 for the proactive screen-change monitor.
        @param callback: (Callable[[str], None]) Called with the new description text.
        """
        self._on_description_ready = callback

    def on_frame_captured(self, frame_bytes: bytes) -> None:
        """
        purpose: Receive a newly captured frame from ScreenCapture (SCREEN-9 event-driven).
                 Always stores the frame in _latest_received_frame for describe_now().
                 Triggers a background Gemini describe if neither rate-limited nor an
                 in-flight describe is already running.
        @param frame_bytes: (bytes) JPEG bytes of the changed frame.
        """
        self._latest_received_frame = frame_bytes  # always store for describe_now()
        now = time.monotonic()
        # Safe to read _describing without the lock: single-threaded asyncio guarantees
        # no preemption between this check and the create_task call below.
        if self._describing:
            return  # in-flight — new frame already stored; _describe will use it next time
        if now - self._last_describe_time < DESCRIBE_RATE_LIMIT_S:
            return  # rate-limited
        asyncio.create_task(self._describe(frame_bytes))  # noqa: RUF006
        self._last_describe_time = now

    def start(self) -> None:
        """
        purpose: Wire the on_frame_captured callback to ScreenCapture (SCREEN-9).
                 Must be called after ScreenCapture.start_capture() so frames are live.
                 Replaces the old poll loop start (no asyncio.Task created here).
        """
        self._stopped = False
        self._screen_capture.set_on_frame_captured(self.on_frame_captured)

    def stop(self) -> None:
        """
        purpose: Unregister the frame callback and clear all cached state.
                 Sets _stopped so any in-flight _describe task bails before firing
                 the on_description_ready callback. Safe to call multiple times.
        """
        self._stopped = True
        self._screen_capture.set_on_frame_captured(None)
        self._latest_received_frame = None
        self._last_described_frame = None
        self._latest_description_text = None
        self._last_description_time = 0.0
        self._last_describe_time = 0.0
        self._describing = False

    def get_description(self) -> str | None:
        """
        purpose: Return the latest cached description text, or None if no description
                 has been produced yet (cold start).
        @return: (str | None) Human-readable description text block, or None.
        """
        return self._latest_description_text

    @property
    def last_description_time(self) -> float:
        """
        purpose: Return the monotonic timestamp of the most recent successful Gemini call.
        @return: (float) time.monotonic() value, or 0.0 if no describe has run yet.
        """
        return self._last_description_time

    async def describe_now(self) -> str:
        """
        purpose: On-demand Gemini describe call used by the refresh_vision function tool.
                 Acquires _describe_lock so if a background describe is in flight, this
                 waits for that result instead of issuing a redundant Gemini call.
                 Returns cached description immediately if it is very fresh (< 1s old).
        @return: (str) Fresh human-readable description text, or fallback string on error.
        """
        async with self._describe_lock:
            if (
                self._latest_description_text
                and time.monotonic() - self._last_description_time
                < DESCRIBE_NOW_CACHE_FRESH_S
            ):
                return self._latest_description_text
            frame_bytes = self._latest_received_frame
            if not frame_bytes:
                return self._latest_description_text or "Screen content not available."
            try:
                json_str = await self._call_gemini(frame_bytes)
                self._latest_description_text = self._json_to_text(json_str)
                self._last_description_time = time.monotonic()
                self._last_described_frame = frame_bytes
            except Exception:
                logger.exception("ScreenDescriber.describe_now: Gemini call failed")
            return self._latest_description_text or "Screen content not available."

    async def _describe(self, frame_bytes: bytes) -> None:
        """
        purpose: Call Gemini with the given frame bytes, update the cached description,
                 and fire the on_description_ready callback. Wrapped in a lock so that
                 concurrent background describe and describe_now() calls are serialized.
                 Checks _stopped after acquiring the lock so that a task scheduled before
                 stop() was called does not fire the callback post-teardown.
                 After completing, checks if _latest_received_frame differs from what was
                 just described (i.e. a new frame arrived during the Gemini call). If so,
                 schedules another _describe() immediately to close the latency gap.
                 Errors are logged and the stale description is preserved.
        @param frame_bytes: (bytes) JPEG frame bytes to describe.
        """
        async with self._describe_lock:
            if self._stopped:
                return
            self._describing = True
            try:
                json_str = await self._call_gemini(frame_bytes)
                self._latest_description_text = self._json_to_text(json_str)
                self._last_description_time = time.monotonic()
                self._last_described_frame = frame_bytes
                if self._on_description_ready and self._latest_description_text:
                    self._on_description_ready(self._latest_description_text)
            except Exception:
                logger.exception(
                    "ScreenDescriber: Gemini call failed, keeping stale description"
                )
            finally:
                self._describing = False

        # Outside the lock: if a newer frame arrived while we were describing,
        # schedule another describe to avoid stale-screen gaps. Rate-limit this
        # path the same as on_frame_captured to prevent back-to-back Gemini chains
        # during sustained screen activity (e.g. continuous ReplayKit frames).
        # Also claim _describing before create_task so on_frame_captured does not
        # schedule a duplicate task for the same frame.
        pending = self._latest_received_frame
        now = time.monotonic()
        if (
            not self._stopped
            and not self._describing
            and pending is not None
            and pending is not self._last_described_frame
            and now - self._last_describe_time >= DESCRIBE_RATE_LIMIT_S
        ):
            self._describing = True
            self._last_describe_time = now
            asyncio.create_task(self._describe(pending))  # noqa: RUF006

    async def _call_gemini(self, frame_bytes: bytes) -> str:
        """
        purpose: Send frame_bytes to Gemini with the structured JSON prompt
                 and return the raw response text. Includes workflow step context in the
                 prompt when a workflow is active, so Gemini can populate target_visible
                 and step_complete accurately.
        @param frame_bytes: (bytes) JPEG image bytes to analyze.
        @return: (str) Raw Gemini response text (expected to be JSON).
        """
        step_ctx = self._engine.get_current_step_context()
        if step_ctx:
            prompt = _DESCRIBE_PROMPT_WITH_STEP.format(
                base=_DESCRIBE_PROMPT_BASE, step_ctx=step_ctx
            )
        else:
            prompt = _DESCRIBE_PROMPT_BASE

        contents: list[genai.types.Part | str] = [
            genai.types.Part.from_bytes(data=frame_bytes, mime_type="image/jpeg"),
            prompt,
        ]
        response = await self._genai_client.aio.models.generate_content(
            model=DESCRIBE_LLM_MODEL,
            contents=contents,  # type: ignore[arg-type]
        )
        return str(response.text)

    def _json_to_text(self, json_str: str) -> str:
        """
        purpose: Convert a Gemini JSON response string to a human-readable text block
                 for injection into Haiku's context. Strips markdown code fences first
                 (Gemini frequently outputs ```json ... ``` despite strict prompts).
                 Falls back to returning the raw string on JSON parse failure so Haiku
                 can still read partial text.
        @param json_str: (str) Raw JSON string from Gemini, possibly with markdown fences.
        @return: (str) Human-readable description text block.
        """
        # Strip markdown code fences Gemini sometimes adds despite the prompt
        clean = _FENCE_RE.sub("", json_str.strip())
        try:
            data = json.loads(clean)
        except json.JSONDecodeError:
            logger.warning("ScreenDescriber: Gemini returned non-JSON; using raw text")
            return clean

        app = data.get("current_app", "Unknown")
        screen = data.get("current_screen", "Unknown")

        lines = [f"App: {app} | Screen: {screen}"]

        target_visible = data.get("target_visible")
        target_desc = data.get("target_description", "")
        target_pos = data.get("target_position", "")
        step_complete = data.get("step_complete")

        if target_visible is not None:
            visibility = "VISIBLE" if target_visible else "NOT VISIBLE"
            target_line = f"Target ({target_desc}): {visibility}"
            if target_visible and target_pos:
                target_line += f" at {target_pos}"
            lines.append(target_line)

        if step_complete is not None:
            lines.append(f"Step complete: {'YES' if step_complete else 'NO'}")

        elements = data.get("notable_elements", [])
        if elements:
            elem_parts = [
                f"{e.get('label', '?')} ({e.get('position', '?')})" for e in elements
            ]
            lines.append("Elements: " + ", ".join(elem_parts))

        unexpected = data.get("unexpected_elements", [])
        if unexpected:
            lines.append("Unexpected: " + ", ".join(unexpected))

        return "\n".join(lines)
