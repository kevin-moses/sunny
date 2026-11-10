# agent.py
# Purpose: LiveKit voice agent for Sunny, a memory-care assistant for seniors.
# Implements a Deepgram STT -> Claude Haiku LLM -> Cartesia TTS pipeline via LiveKit Agents.
# Loads the household's context (today's tasks, events, life profile, memory) from
# Convex at session start, logs all conversation turns in real time, and on shutdown stores a
# post-session summary and the senior's questions (memory.py). The senior reaches it by
# pressing Talk on the home display, so no tool depends on a phone: messages to family go
# through Convex (send_family_message), not the phone's contacts or SMS.
#
# Tools (each backed by an agent:* Convex function except web_search and get_weather):
# web_search (Tavily), get_weather (Open-Meteo, weather.py, for the household's
# weatherLocation), list_today, confirm_task (already-done guard), snooze_task ("not yet",
# 15 minutes), medication_status, log_dose and undo_last_dose (label facts; a dose past a
# limit flags the caregiver), create_reminder and cancel_reminder (senior-created reminders
# only), remember_fact (unverified senior memory), flag_caregiver, send_family_message,
# read_latest_message, and the household list: add_to_list, read_list, take_off_list. The
# phone-RPC tools find_contact and send_message were removed
# (2026-11-09): the display has no contacts or SMS.
#
# Error handling: STT garbage filter silences short/non-alphabetic transcripts; progressive
# error recovery speaks escalating messages on LLM/STT/TTS failures; the participant
# disconnect handler finalizes the conversation. A failing tool returns a short plain sentence
# for the model, never a raw error.
#
# Opening (2026-11-09): a Talk press means the senior has a question, so a "talk" session
# opens silently and listens; the display shows that it is listening. Only a session started
# by a task that is still open (scheduled_prompt or notification_tap with task_instance_id)
# opens by speaking that task's fixed spoken prompt. Nothing else is spoken unprompted: no
# greeting, no "welcome back" on reconnect. A spoken cue was rejected because a one-word cue
# echoed back through the microphone would pass the echo filter (single words are never
# treated as echo) and be answered as if the senior had said it.
#
# Review fixes (2026-11-09): the opening prompt is spoken only for a task that is due or
# escalated, in the task's own words or the spec template (label, pills, "Press Done when
# you've taken them"; no clock time); short real words ("Hi", "no") pass the garbage filter,
# filler sounds do not; watch_inactivity ends a session with no speech for
# INACTIVITY_TIMEOUT_S; TTS speaks at TTS_SPEED on TTS_MODEL; Tavily runs off the event loop;
# medication_limit is not a model-facing flag reason; new tools undo_last_dose, add_to_list,
# read_list and take_off_list (list_tools.py).
#
# Session context: resolve_session() reads household_id, trigger, task_instance_id and
# device_id from participant metadata. Session context is also persisted to the
# conversations row via create_conversation().
#
# Echo detection: _is_echo() and _normalize_for_echo() detect when STT transcribes the
# agent's own TTS output back as user speech (AEC calibration issue on first call).
# _on_item_added buffers normalized assistant text; _on_user_input_transcribed checks
# user transcripts against the buffer and suppresses matches via session.interrupt().
#
# Memory-care pivot: screen share, vision, guided iPhone workflows, and the iOS EventKit
# reminder tool were removed (out of scope for the memory-care POC). Sessions are scoped
# to a household on the new shared-state schema (notes/SCHEMA.md).
# Convex migration (2026-10-29): supabase-py replaced by ConvexClient (convex_client.py).
# Shutdown: a single shutdown callback is registered right after the Convex client is created
# (so the client is closed even if setup fails); it finalizes the conversation, drains pending
# turn writes (memory.shutdown_conversation) and only then closes the client.
#
# Last modified: 2026-11-09

import asyncio
import json
import logging
import re
from collections.abc import Awaitable, Callable
from typing import Literal

from dotenv import load_dotenv
from livekit import rtc
from livekit.agents import (
    NOT_GIVEN,
    Agent,
    AgentFalseInterruptionEvent,
    AgentSession,
    ConversationItemAddedEvent,
    JobContext,
    JobProcess,
    MetricsCollectedEvent,
    RoomInputOptions,
    RunContext,
    WorkerOptions,
    cli,
    metrics,
)
from livekit.agents.llm import ChatContext, ChatMessage, function_tool
from livekit.plugins import anthropic, cartesia, deepgram, noise_cancellation, silero
from livekit.plugins.turn_detector.multilingual import MultilingualModel
from tavily import TavilyClient

from config import (
    DEFAULT_TIMEZONE,
    ECHO_DETECTION_WINDOW_S,
    INACTIVITY_CHECK_S,
    INACTIVITY_TIMEOUT_S,
    LLM_MODEL,
    MAX_ENDPOINTING_DELAY,
    MIN_ENDPOINTING_DELAY,
    MIN_INTERRUPTION_DURATION,
    MIN_INTERRUPTION_WORDS,
    STT_LANGUAGE,
    STT_MODEL,
    TTS_MODEL,
    TTS_SPEED,
    TTS_VOICE,
)
from convex_client import ConvexClient, create_convex_client
from list_tools import db_add_to_list, db_read_list, db_take_off_list
from memory import (
    ConversationLogger,
    create_conversation,
    load_agent_context,
    resolve_session,
    shutdown_conversation,
)
from prompts import format_user_context, render_system_prompt
from tools import (
    db_cancel_senior_reminder,
    db_confirm_task,
    db_create_senior_reminder,
    db_flag_caregiver,
    db_list_today,
    db_log_dose,
    db_medication_status,
    db_read_latest_message,
    db_remember_fact,
    db_send_family_message,
    db_snooze_task,
    db_undo_last_dose,
)
from weather import Place, WeatherError, lookup_place, weather_report

logger = logging.getLogger("agent")

load_dotenv(".env")

# medication_limit is raised by log_dose itself (keyed on the medication), never by the model.
FlagReason = Literal[
    "symptom",
    "money_request",
    "scam",
    "distress",
    "help_requested",
]


class Assistant(Agent):
    """
    purpose: Voice assistant agent for the senior. Exposes tools for web search, weather,
             today's tasks (list, confirm, snooze), medications (status, self-reported
             doses), senior-created reminders, memory, and reaching family (flag, message,
             latest message).
    """

    def __init__(
        self,
        instructions: str,
        household_id: str | None,
        convex: ConvexClient,
        timezone: str = DEFAULT_TIMEZONE,
        conversation_id: str = "",
        weather_location: str | None = None,
        prompt_label: str = "",
    ) -> None:
        """
        purpose: Initialize the Assistant with a pre-rendered system prompt and the
                 Convex client + household needed for the household tools.
        @param instructions: (str) The fully rendered system prompt from render_system_prompt().
        @param household_id: (str | None) Household id; None disables the household tools.
        @param convex: (ConvexClient) Convex client carrying the agent key.
        @param timezone: (str) IANA timezone of the household, used to phrase dates.
        @param conversation_id: (str) This session's conversation, linked to facts, flags and
                                messages; "" when none was opened.
        @param weather_location: (str | None) households.weatherLocation, e.g. "Brooklyn, NY".
        @param prompt_label: (str) Display label of the task that started the session, used
                             when "done" or "not yet" names no task; "" for a Talk press.
        """
        super().__init__(instructions=instructions)
        self._household_id = household_id
        self._convex = convex
        self._timezone = timezone
        self._conversation_id = conversation_id or None
        self._weather_location = (weather_location or "").strip()
        self._weather_place: Place | None = None
        self._prompt_label = prompt_label
        # Created on the first search, so a missing TAVILY_API_KEY only disables web_search.
        self._tavily: TavilyClient | None = None

    @function_tool
    async def web_search(self, context: RunContext, query: str):
        """
        purpose: Look up current information on the web using Tavily search.

        Args:
            query: The search query to look up

        Returns:
            The search results or an error message
        """
        logger.info(f"Looking up information on {query}")
        await context.session.say("Let me look that up.")
        try:
            if self._tavily is None:
                self._tavily = TavilyClient()
            # The Tavily client is synchronous: run it off the event loop so audio keeps flowing.
            response = await asyncio.to_thread(
                self._tavily.search, query, include_answer="basic"
            )
            answer = (response or {}).get("answer")
            logger.info(f"Answer: {answer}")
            return answer or "No results found for that query."
        except Exception as e:
            logger.error(f"Error looking up information on {query}: {e}")
            return "The web search is not working right now, so this could not be looked up."

    @function_tool
    async def get_weather(self, context: RunContext) -> str:
        """
        purpose: Current weather and today's hourly forecast (temperature, conditions,
                 chance of rain by hour) for the household's location. Use the hour of a
                 scheduled activity to answer questions like "Do I need an umbrella for
                 my walk?".

        Returns:
            Current conditions and the rest of today by hour, or why it is unavailable
        """
        if not self._weather_location:
            return (
                "No weather location is set up for this household. Use web_search for "
                "the weather instead."
            )
        try:
            if self._weather_place is None:
                self._weather_place = await lookup_place(self._weather_location)
            if self._weather_place is None:
                return (
                    f"The weather location '{self._weather_location}' was not found. "
                    "Use web_search for the weather instead."
                )
            return await weather_report(self._weather_place, self._timezone)
        except WeatherError as e:
            logger.error(f"Weather lookup failed: {e}")
            return "The weather service is not answering right now."

    async def _household_tool(
        self, what: str, call: Callable[[str], Awaitable[str]]
    ) -> str:
        """
        purpose: Shared guard for the task tools: needs a household, and turns any
                 database error into a short spoken apology instead of a crash.
        @param what: (str) What the tool does, for logs and the apology ("check today's schedule").
        @param call: (Callable[[str], Awaitable[str]]) Coroutine factory taking the household id.
        @return: (str) The helper's voice-friendly result, or a fallback message.
        """
        if not self._household_id:
            return f"I can't {what} right now."
        try:
            return await call(self._household_id)
        except Exception as e:
            logger.error(f"Error trying to {what}: {e}")
            return f"I'm sorry, I had trouble trying to {what}."

    @function_tool
    async def list_today(self, context: RunContext) -> str:
        """
        purpose: Read today's schedule and what has already been done, so questions like
                 "Did I take my pills?" or "What's next today?" are answered from the
                 household's live state rather than memory.

        Returns:
            Voice-friendly list of today's tasks with their status
        """
        return await self._household_tool(
            "check today's schedule",
            lambda h: db_list_today(self._convex, h, self._timezone),
        )

    @function_tool
    async def confirm_task(self, context: RunContext, task_name: str = "") -> str:
        """
        purpose: Record that the senior did a task ("I took them", "done"). Confirms the
                 matching task on today's schedule, or the one due now when no name is
                 given. If it was already confirmed, returns when, so the senior is never
                 told to repeat a dose. Only call when the senior clearly says they did it.

        Args:
            task_name: Name or part of the task's label, e.g. "morning pills"; empty for
                       whatever is due now

        Returns:
            Voice-friendly confirmation, already-done note, or clarifying question
        """
        label = task_name or self._prompt_label
        return await self._household_tool(
            "record that",
            lambda h: db_confirm_task(self._convex, h, self._timezone, label),
        )

    @function_tool
    async def snooze_task(self, context: RunContext, task_name: str = "") -> str:
        """
        purpose: "Not yet", "later", "in a minute" about a task: snooze its reminders for
                 15 minutes. Family alerts are not delayed.

        Args:
            task_name: Name or part of the task's label; empty for whatever is due now

        Returns:
            When the next reminder comes, or why nothing was snoozed
        """
        label = task_name or self._prompt_label
        return await self._household_tool(
            "snooze that",
            lambda h: db_snooze_task(self._convex, h, self._timezone, label),
        )

    @function_tool
    async def medication_status(self, context: RunContext) -> str:
        """
        purpose: Fresh facts for any medication question ("Can I take another pill?",
                 "Did I take my pills?"): today's scheduled medications and when they were
                 taken, and for each as-needed medication the label limits, doses taken
                 today and when another would be within the label.

        Returns:
            The facts, for the senior to decide
        """
        return await self._household_tool(
            "check the medications",
            lambda h: db_medication_status(self._convex, h, self._timezone),
        )

    @function_tool
    async def log_dose(
        self, context: RunContext, medication: str = "", minutes_ago: int = 0
    ) -> str:
        """
        purpose: Record that the senior took an as-needed medication ("I took a Tylenol").
                 Call it once per dose. Returns the label facts afterwards; family is told
                 automatically if the dose is past a label limit. Only for as-needed
                 medications, never for scheduled ones like "my pills" (use confirm_task).

        Args:
            medication: Words naming the medication, e.g. "pain reliever"; empty if only
                        one as-needed medication is on file
            minutes_ago: How many minutes ago they took it; 0 for just now

        Returns:
            What was logged and the label facts, or why nothing was logged
        """
        return await self._household_tool(
            "log that",
            lambda h: db_log_dose(
                self._convex,
                h,
                self._timezone,
                medication,
                minutes_ago,
                self._conversation_id,
            ),
        )

    @function_tool
    async def undo_last_dose(self, context: RunContext, medication: str = "") -> str:
        """
        purpose: Take back an as-needed dose they reported today and did not actually take
                 ("No, I didn't take it after all"). Anything already sent to family stays
                 sent.

        Args:
            medication: Words naming the medication; empty for the last one they reported

        Returns:
            What was removed, or why nothing was
        """
        return await self._household_tool(
            "take that back",
            lambda h: db_undo_last_dose(
                self._convex, h, self._timezone, medication, self._conversation_id
            ),
        )

    @function_tool
    async def add_to_list(self, context: RunContext, items: list[str]) -> str:
        """
        purpose: Add things to the household's shared list, which family can see ("Add milk
                 and eggs to the list"). Call it right away with every item they named; no
                 confirmation is needed.

        Args:
            items: Each item separately, short, e.g. ["milk", "eggs"]

        Returns:
            What was added and what was already on the list
        """
        return await self._household_tool(
            "add that to the list",
            lambda h: db_add_to_list(self._convex, h, items),
        )

    @function_tool
    async def read_list(self, context: RunContext) -> str:
        """
        purpose: Read the household list ("What's on my list?").

        Returns:
            The open items, or the count and the first few of a long list
        """
        return await self._household_tool(
            "read the list", lambda h: db_read_list(self._convex, h)
        )

    @function_tool
    async def take_off_list(self, context: RunContext, item: str) -> str:
        """
        purpose: Take an item off the list when they got it or no longer need it ("I bought
                 the milk").

        Args:
            item: The item, e.g. "milk"

        Returns:
            What was taken off, or a clarifying note
        """
        return await self._household_tool(
            "update the list", lambda h: db_take_off_list(self._convex, h, item)
        )

    @function_tool
    async def create_reminder(
        self,
        context: RunContext,
        title: str,
        time: str,
        on_date: str = "",
        days: list[str] | None = None,
    ) -> str:
        """
        purpose: Create a reminder the senior asked for, e.g. "remind me to call the
                 plumber tomorrow at 10". Family caregivers can see it in their app. Call it
                 right away; no confirmation is needed.

        Args:
            title: What to remind them about, phrased to follow "remind you to", e.g. "call the plumber"
            time: 24-hour time, e.g. "10:00"
            on_date: Date "YYYY-MM-DD" for a one-time reminder; empty for a recurring one
            days: For recurring reminders, day abbreviations like ["mon","wed"]; empty means every day

        Returns:
            Voice-friendly confirmation message
        """
        logger.info(f"Creating senior reminder: {title} at {time} on {on_date or days}")
        return await self._household_tool(
            "save that reminder",
            lambda h: db_create_senior_reminder(
                self._convex, h, self._timezone, title, time, on_date, days
            ),
        )

    @function_tool
    async def cancel_reminder(self, context: RunContext, reminder_title: str) -> str:
        """
        purpose: Cancel a reminder the senior created earlier, by title. Reminders and
                 tasks set up by family cannot be cancelled here.

        Args:
            reminder_title: The name or part of the name of the reminder to cancel

        Returns:
            Voice-friendly confirmation, not-found message, or clarification request
        """
        return await self._household_tool(
            "cancel that reminder",
            lambda h: db_cancel_senior_reminder(self._convex, h, reminder_title),
        )

    @function_tool
    async def remember_fact(self, context: RunContext, fact: str) -> str:
        """
        purpose: Remember something the senior says ("Remember that...", "I put my glasses
                 in the hall drawer"). Stored as unverified until family confirms it; it
                 never changes anything family wrote.

        Args:
            fact: The fact as a full sentence with names, e.g. "Margaret put her glasses in
                  the hall drawer."

        Returns:
            Whether it was noted
        """
        return await self._household_tool(
            "note that",
            lambda h: db_remember_fact(self._convex, h, fact, self._conversation_id),
        )

    @function_tool
    async def flag_caregiver(
        self, context: RunContext, reason: FlagReason, detail: str
    ) -> str:
        """
        purpose: Let the on-call family caregiver know something needs their attention:
                 a new or repeated symptom, someone asking for money, anything that sounds
                 like a scam, signs of distress, or the senior asking for family. Call once
                 per concern.

        Args:
            reason: The kind of concern
            detail: At most two short plain sentences for the caregiver about what happened.
                    Never include card, bank or account numbers.

        Returns:
            Who was told, or that family could not be reached
        """
        return await self._household_tool(
            "reach your family",
            lambda h: db_flag_caregiver(
                self._convex, h, reason, detail, self._conversation_id
            ),
        )

    @function_tool
    async def send_family_message(
        self, context: RunContext, message: str, to: str = ""
    ) -> str:
        """
        purpose: Send a message from the senior to family through the Sunny app ("Tell
                 Sarah I'm home"). Read the message back and get a yes before calling.

        Args:
            message: The message in the senior's words, e.g. "I'm home"
            to: The name of the person it is for, e.g. "Sarah"; empty for the family

        Returns:
            Who received it
        """
        return await self._household_tool(
            "send that message",
            lambda h: db_send_family_message(
                self._convex, h, to, message, self._conversation_id
            ),
        )

    @function_tool
    async def read_latest_message(self, context: RunContext) -> str:
        """
        purpose: Read the newest message family sent ("What did Sarah send?", "Any
                 messages?"). Marks it as read.

        Returns:
            Who sent it, when, and what it says
        """
        return await self._household_tool(
            "read the messages",
            lambda h: db_read_latest_message(self._convex, h, self._timezone),
        )


# Sounds STT writes for hesitation or noise; alone they are not something to answer.
_FILLER_WORDS = {"uh", "um", "hm", "hmm", "mm", "mhm", "er", "ah", "eh", "oh"}


def _is_garbage_input(text: str) -> bool:
    """
    purpose: Return True if an STT transcript is noise rather than speech: no letters, a
             single letter, or only filler sounds ("um", "hmm"). Short real words such as
             "Hi", "no" or "ok" pass, so a bare greeting after a silent Talk open is answered.
    @param text: (str) Stripped transcript string from the STT engine.
    @return: (bool) True if the input should be discarded without LLM processing.
    """
    words = re.findall(r"[^\W\d_]+", text.lower())
    if sum(len(w) for w in words) < 2:
        return True
    return all(w in _FILLER_WORDS for w in words)


# Echo detection helpers — detect when STT transcribes the agent's own
# TTS output back as user speech, a known AEC calibration issue on first call.
_ECHO_NORMALIZE_RE = re.compile(r"[^a-z0-9 ]")
_ECHO_MULTISPACES_RE = re.compile(r" {2,}")


def _normalize_for_echo(text: str) -> str:
    """
    purpose: Normalize text for echo comparison by lowercasing, stripping punctuation,
             and collapsing multiple spaces produced by multi-char punctuation (em-dash).
    @param text: (str) Raw transcript or agent speech text.
    @return: (str) Lowercase text with only alphanumeric characters and single spaces.
    """
    stripped = _ECHO_NORMALIZE_RE.sub("", text.lower()).strip()
    return _ECHO_MULTISPACES_RE.sub(" ", stripped)


def _is_echo(
    text: str,
    recent_agent_texts: list[tuple[float, str]],
    now: float,
    window: float,
) -> bool:
    """
    purpose: Check whether a user transcript is an echo of recent agent speech.
             Uses word-overlap ratio rather than exact substring because STT
             garbles the echo (e.g. "I want to get showing" for "I want to make
             sure"). A transcript is considered echo if >= 60% of its words appear
             in any agent text spoken within the detection window.
    @param text: (str) Raw user transcript from STT.
    @param recent_agent_texts: (list[tuple[float, str]]) Buffer of
           (timestamp, normalized_agent_text) pairs.
    @param now: (float) Current event loop time.
    @param window: (float) Detection window in seconds.
    @return: (bool) True if the transcript matches recent agent speech.
    """
    normalized = _normalize_for_echo(text)
    words = normalized.split()
    if len(words) < 2:
        return False  # single words like "yeah" or "ok" are never echo
    word_set = set(words)
    for ts, agent_text in recent_agent_texts:
        if now - ts > window:
            continue
        agent_words = set(agent_text.split())
        if not agent_words:
            continue
        overlap = len(word_set & agent_words) / len(word_set)
        if overlap >= 0.6:
            return True
    return False


def _recovery_message(consecutive_errors: int, name: str) -> str:
    """
    purpose: Return a progressive recovery message based on how many consecutive
             session errors have occurred. First error is gentle; third+ is honest.
    @param consecutive_errors: (int) Count of errors since last successful assistant turn.
    @param name: (str) User's first name, or empty string if unknown.
    @return: (str) Voice-friendly recovery message for the agent to speak.
    """
    if consecutive_errors == 1:
        return "I'm thinking about that — give me just a moment."
    elif consecutive_errors == 2:
        hint = f", {name}" if name else ""
        return f"I'm having a little trouble{hint}. Could you try saying that again?"
    else:
        return "I'm having some technical difficulties. You might want to try again in a few minutes."


def _opening_prompt(
    context: dict, task_instance_id: str | None
) -> tuple[str | None, str]:
    """
    purpose: Decide how a session opens. Only a session started by a task instance that is
             due or escalated speaks first, with the task's fixed prompt (_task_prompt, same
             words every day). A Talk press, or a task done, missed or upcoming, opens
             silently.
    @param context: (dict) agent:getContext result ({} when unavailable).
    @param task_instance_id: (str | None) The instance from the participant metadata.
    @return: (tuple[str | None, str]) The prompt to speak (None to stay silent) and the
             task's display label ("" when no task started the session), which "done" and
             "not yet" use when they name no task.
    """
    if not task_instance_id:
        return None, ""
    instance = next(
        (
            i
            for i in context.get("today", [])
            if i.get("instanceId") == task_instance_id
        ),
        None,
    )
    if instance is None:
        return None, ""
    label = instance.get("displayLabel", "")
    # Only a task open for confirmation right now is prompted; a tap on a missed or upcoming
    # one must not announce it hours late or early.
    if instance.get("state") not in ("due", "escalated"):
        return None, label
    return _task_prompt(instance), label


def _task_prompt(instance: dict) -> str:
    """
    purpose: The fixed words for a task's prompt: the caregiver's own spoken prompt, or when
             there is none (or only the backend's bare "Time for <label>."), the spec template:
             the label, the pill description when present, and how to confirm. No clock time,
             so a reprompt is never wrong, and the same words every day.
    @param instance: (dict) A today entry (displayLabel, spokenPrompt, type, pillDescription).
    @return: (str) e.g. "Time for your morning pills, the small white ones. Press Done when
             you've taken them."
    """
    label = " ".join(str(instance.get("displayLabel") or "your task").split())
    spoken = " ".join(str(instance.get("spokenPrompt") or "").split())
    if spoken and spoken != f"Time for {label}.":
        return spoken
    name = label[:1].lower() + label[1:]
    text = (
        f"Time for your {name}" if not name.startswith("your ") else f"Time for {name}"
    )
    pills = " ".join(str(instance.get("pillDescription") or "").split())
    if pills:
        text += f", the {pills}"
    if instance.get("type") == "medication":
        return f"{text}. Press Done when you've taken them."
    return f"{text}. Press Done when it's done."


def prewarm(proc: JobProcess):
    """
    purpose: Load the Silero VAD model before the first job to avoid cold-start latency.
    @param proc: (JobProcess) The worker process, used to store the VAD in shared userdata.
    """
    proc.userdata["vad"] = silero.VAD.load()


async def entrypoint(ctx: JobContext):
    """
    purpose: Main session entrypoint. Connects to the room first so participant
             metadata is available, then loads user context from Convex, builds
             the system prompt, and starts the voice pipeline with senior-optimized
             UX parameters and real-time conversation logging.
             Also registers error recovery, the STT garbage and echo filter, and the
             disconnect handler. A Talk session opens silently and listens; a session
             started by a still-open task opens with that task's fixed spoken prompt.
    @param ctx: (JobContext) LiveKit job context providing room access and lifecycle hooks.
    """
    ctx.log_context_fields = {"room": ctx.room.name}

    # 1. Connect first — gives us access to participant metadata before building the prompt
    await ctx.connect()

    # 2. Resolve household and session context from participant metadata (or fallbacks)
    session_ctx = resolve_session(ctx.room)
    household_id = session_ctx["household_id"]
    session_instance_id = session_ctx["task_instance_id"]

    # 3. Init Convex; load household context and create the conversation row together
    convex = create_convex_client()
    shutdown_logger: ConversationLogger | None = None
    history_source: Callable[[], ChatContext] | None = None

    # Registered immediately so the client is closed even if setup below fails. It runs the
    # end-of-session writes (finalize, turn drain) before closing, in that order.
    async def _on_shutdown():
        """
        purpose: Finalize the conversation (a safety fallback when no disconnect event
                 fired, and a wait for the one that did), drain pending turn writes, then
                 close the Convex client. The client is closed even if setup failed early.
        """
        await shutdown_conversation(
            convex,
            shutdown_logger,
            history_source() if history_source is not None else None,
        )

    ctx.add_shutdown_callback(_on_shutdown)

    raw_context, conversation_id = await asyncio.gather(
        load_agent_context(convex, household_id),
        create_conversation(
            convex,
            household_id,
            trigger=session_ctx["trigger"],
            task_instance_id=session_instance_id,
            device_id=session_ctx["device_id"],
        ),
    )
    household = raw_context.get("household", {})
    user_name = household.get("seniorPreferredName", "")
    household_timezone = household.get("timezone", DEFAULT_TIMEZONE)
    conv_logger = ConversationLogger(
        convex, conversation_id, raw_context.get("recentQuestionTopics") or []
    )
    shutdown_logger = conv_logger

    # 4. Only a session started by a still-open task speaks first, with its fixed prompt
    initial_prompt, prompt_label = _opening_prompt(raw_context, session_instance_id)
    if initial_prompt:
        logger.info(f"Task prompt opening: {initial_prompt!r}")

    # 5. Render system prompt with injected household context
    context_block = format_user_context(raw_context)
    rendered_prompt = render_system_prompt(context_block, user_name)
    logger.info(f"System prompt rendered for household_id={household_id}")

    # 6. Build session with senior-optimized voice UX parameters
    session = AgentSession(
        stt=deepgram.STT(model=STT_MODEL, language=STT_LANGUAGE),
        llm=anthropic.LLM(model=LLM_MODEL),
        tts=cartesia.TTS(model=TTS_MODEL, voice=TTS_VOICE, speed=TTS_SPEED),
        turn_detection=MultilingualModel(),
        vad=ctx.proc.userdata["vad"],
        preemptive_generation=True,
        min_endpointing_delay=MIN_ENDPOINTING_DELAY,
        max_endpointing_delay=MAX_ENDPOINTING_DELAY,
        min_interruption_duration=MIN_INTERRUPTION_DURATION,
        min_interruption_words=MIN_INTERRUPTION_WORDS,
    )

    def _session_history() -> ChatContext:
        """
        purpose: Give _on_shutdown access to the session history once the session exists.
        @return: (ChatContext) The AgentSession history.
        """
        return session.history

    history_source = _session_history

    # 7. State variables for error recovery and the task prompt
    consecutive_errors = 0
    _opened = False
    _recent_agent_texts: list[tuple[float, str]] = []  # echo detection buffer

    # 8. Real-time message logging — fires on every completed conversation turn.
    #    Also buffers assistant speech text for echo detection.
    @session.on("conversation_item_added")
    def _on_item_added(ev: ConversationItemAddedEvent):
        """
        purpose: Handle conversation_item_added events to log each turn to Convex,
                 reset the error streak counter on any successful assistant reply,
                 and buffer assistant text for echo detection.
        @param ev: (ConversationItemAddedEvent) Event containing the new ChatMessage.
        """
        nonlocal consecutive_errors
        item = ev.item
        if isinstance(item, ChatMessage):
            if item.role == "assistant":
                consecutive_errors = 0  # successful response — reset error streak
            if item.role in ("user", "assistant"):
                text = item.text_content
                if text:
                    conv_logger.track_log_message(item.role, text)
                    # Buffer assistant speech for echo detection.
                    # Cap at 50 entries to prevent unbounded growth if user
                    # never speaks (pruning only happens in the STT handler).
                    if item.role == "assistant":
                        if len(_recent_agent_texts) >= 50:
                            _recent_agent_texts.pop(0)
                        _recent_agent_texts.append(
                            (
                                asyncio.get_running_loop().time(),
                                _normalize_for_echo(text),
                            )
                        )

    # 9. STT garbage/echo filter — silently discard noise and echo before the LLM responds
    @session.on("user_input_transcribed")
    def _on_user_input_transcribed(ev):
        """
        purpose: Discard short or non-alphabetic STT transcripts (coughs, TV, brief noise)
                 and detect agent echo where AEC leaks TTS output back through
                 the mic as a spurious user turn. Calls session.interrupt() to suppress
                 the LLM response for both garbage and echo inputs.
        @param ev: Event with .is_final (bool) and .transcript (str).
        """
        if not ev.is_final:
            return
        text = ev.transcript.strip()
        if _is_garbage_input(text):
            logger.info(
                f"Ignoring garbage STT input (household={household_id}): {text!r}"
            )
            session.interrupt()
            return
        # Echo detection: prune old entries and check for echo
        now = asyncio.get_running_loop().time()
        _recent_agent_texts[:] = [
            (ts, t)
            for ts, t in _recent_agent_texts
            if now - ts < ECHO_DETECTION_WINDOW_S
        ]
        if _is_echo(text, _recent_agent_texts, now, ECHO_DETECTION_WINDOW_S):
            logger.info(f"Ignoring echo STT input (household={household_id}): {text!r}")
            session.interrupt()
            return

    # 10. Progressive error recovery — speak an escalating message on pipeline failures
    @session.on("error")
    def _on_session_error(ev):
        """
        purpose: Speak a recovery message when the LLM, STT, or TTS encounters an error.
                 Escalates wording on repeated consecutive failures.
        @param ev: Event with .error describing the failure.
        """
        nonlocal consecutive_errors
        consecutive_errors += 1
        logger.error(
            f"Session error #{consecutive_errors} (household={household_id}, "
            f"conversation={conversation_id}): {ev.error}"
        )
        try:
            session.say(_recovery_message(consecutive_errors, user_name))
        except Exception:
            logger.warning(
                "session.say() failed in error handler; speech scheduler draining"
            )

    # 11. Task prompt — a session started by an open task speaks its fixed prompt once, when
    #     the agent first goes idle and the senior is not already talking. A Talk press opens
    #     silently and listens (see the file header).
    @session.on("agent_state_changed")
    def _on_agent_state_changed(ev):
        """
        purpose: Speak the task's fixed spoken prompt the first time the agent reaches idle
                 state, when the session was started by a still-open task and nobody has
                 spoken yet. Does nothing for a Talk press.
        @param ev: Event with .new_state (str) indicating the agent's new pipeline state.
        """
        nonlocal _opened
        if ev.new_state != "idle" or _opened:
            return
        _opened = True
        if not initial_prompt:
            return
        if session.user_state != "speaking" and len(session.history.items) == 0:
            session.say(initial_prompt)

    # 12. Participant disconnect — finalize the conversation (summary and questions)
    def _on_participant_disconnected(participant):
        """
        purpose: Finalize the conversation when the senior's device leaves the room.
        @param participant: The disconnected LiveKit participant object.
        """
        logger.info(
            f"Participant {participant.identity} disconnected (household={household_id})"
        )
        asyncio.create_task(conv_logger.finalize(session.history))  # noqa: RUF006

    ctx.room.on("participant_disconnected", _on_participant_disconnected)

    # 13b. iOS log forwarding — receive structured log entries published by the iOS app
    # on the "ios.log" topic and re-emit them via Python logging so iOS and server logs
    # appear in the same terminal timeline for cross-side failure diagnosis.
    _ios_log_level_map = {
        "DEBUG": logging.DEBUG,
        "INFO": logging.INFO,
        "WARNING": logging.WARNING,
        "ERROR": logging.ERROR,
    }

    def _on_data_received(packet: rtc.DataPacket) -> None:
        """
        purpose: Receive data messages from room participants and re-emit iOS log entries via
                 Python logging so they appear alongside server logs in the same terminal.
                 Accepts packets on topic "ios.log" or with no topic — the latter handles
                 LiveKit SDK versions where the topic field is not transmitted on the wire.
                 Non-log packets (e.g. chat) are filtered out by schema: a valid log payload
                 must have "component" starting with "ios." and a known "level" key.
        @param packet: (rtc.DataPacket) Incoming data packet with .data (bytes), .topic (str|None),
                       and .participant (RemoteParticipant|None).
        """
        # Accept explicit "ios.log" topic or unpopulated topic (SDK version safety)
        if packet.topic not in ("ios.log", "", None):
            return
        try:
            payload = json.loads(packet.data)
            component = payload.get("component", "")
            # Schema guard: only process packets that look like iOS log entries
            if not component.startswith("ios."):
                return
            message = payload.get("message", "")
            level_str = payload.get("level", "INFO")
            level = _ios_log_level_map.get(level_str, logging.INFO)
            ios_logger = logging.getLogger(component)
            ios_logger.log(level, "%s", message, extra=payload.get("metadata") or {})
        except Exception:
            pass

    ctx.room.on("data_received", _on_data_received)

    # 14. False interruption recovery — resume agent speech after background noise
    @session.on("agent_false_interruption")
    def _on_agent_false_interruption(ev: AgentFalseInterruptionEvent):
        """
        purpose: Resume agent speech after a false positive interruption (e.g. cough, TV noise).
        @param ev: (AgentFalseInterruptionEvent) Event with optional extra instructions.
        """
        logger.info("false positive interruption, resuming")
        try:
            session.generate_reply(instructions=ev.extra_instructions or NOT_GIVEN)
        except RuntimeError as e:
            logger.warning("Proactive generate_reply skipped: %s", e)

    # 15. Metrics collection
    usage_collector = metrics.UsageCollector()

    @session.on("metrics_collected")
    def _on_metrics_collected(ev: MetricsCollectedEvent):
        """
        purpose: Collect and log pipeline performance metrics on each turn.
        @param ev: (MetricsCollectedEvent) Event containing the metrics snapshot.
        """
        metrics.log_metrics(ev.metrics)
        usage_collector.collect(ev.metrics)

    # 16. Shutdown callbacks — usage logging. _on_shutdown (registered right after the Convex
    #     client was created) finalizes and closes; the disconnect handler also calls finalize,
    #     which is idempotent and awaited by both callers.
    async def _log_usage():
        """
        purpose: Log aggregate token/audio usage after the session ends.
        """
        summary = usage_collector.get_summary()
        logger.info(f"Usage: {summary}")

    ctx.add_shutdown_callback(_log_usage)

    _assistant = Assistant(
        instructions=rendered_prompt,
        household_id=household_id,
        convex=convex,
        timezone=household_timezone,
        conversation_id=conversation_id,
        weather_location=household.get("weatherLocation"),
        prompt_label=prompt_label,
    )

    # 17. Start session — room is already connected, session.start() will not reconnect
    await session.start(
        agent=_assistant,
        room=ctx.room,
        room_input_options=RoomInputOptions(
            noise_cancellation=noise_cancellation.BVC(),
        ),
    )

    # 18. Inactivity — the worker ends a session nobody speaks in (a silent Talk open that
    #     never gets a question), without relying on the display to hang up.
    _inactivity_task = asyncio.create_task(
        watch_inactivity(
            session,
            lambda: ctx.shutdown(reason="inactive"),
            INACTIVITY_TIMEOUT_S,
            INACTIVITY_CHECK_S,
        )
    )
    ctx.add_shutdown_callback(lambda: _cancel(_inactivity_task))


async def _cancel(task: asyncio.Task) -> None:
    """
    purpose: Cancel a background task at shutdown.
    @param task: (asyncio.Task) The task.
    """
    task.cancel()


async def watch_inactivity(
    session: object,
    end_session: Callable[[], object],
    timeout_s: float,
    check_s: float,
) -> None:
    """
    purpose: End the session once neither side has spoken or been working for timeout_s. The
             session counts as active while the user is speaking or the agent is speaking or
             thinking; the clock restarts each time it is.
    @param session: (object) The AgentSession (reads user_state and agent_state).
    @param end_session: (Callable[[], object]) Called once to end the session.
    @param timeout_s: (float) Seconds of inactivity allowed.
    @param check_s: (float) Seconds between checks.
    """
    loop = asyncio.get_running_loop()
    last_active = loop.time()
    while True:
        await asyncio.sleep(check_s)
        busy = getattr(session, "user_state", None) == "speaking" or getattr(
            session, "agent_state", None
        ) in ("speaking", "thinking")
        if busy:
            last_active = loop.time()
        elif loop.time() - last_active >= timeout_s:
            logger.info(f"No speech for {timeout_s:.0f} s; ending the session")
            end_session()
            return


if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint, prewarm_fnc=prewarm))
