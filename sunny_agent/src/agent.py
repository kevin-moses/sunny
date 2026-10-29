# agent.py
# Purpose: LiveKit voice agent for Sunny, a memory-care assistant for seniors.
# Implements a Deepgram STT -> Claude Haiku LLM -> Cartesia TTS pipeline via LiveKit Agents.
# Loads the household's context (today's tasks, events, life profile, memory) from
# Convex at session start, logs all conversation turns in real time, and stores a
# post-session summary on shutdown. Exposes tool functions for web search, contact
# lookup, and messaging (the latter two delegated to the iOS app over LiveKit RPC), plus
# task tools: list_today, confirm_task (shared confirm function, already-done guard),
# create_reminder and cancel_reminder (senior-created reminders only).
#
# Error handling: STT garbage filter silences short/non-alphabetic transcripts; progressive
# error recovery speaks escalating messages on LLM/STT/TTS failures; participant disconnect
# and reconnect handlers log session end and greet returning users within 10 minutes;
# agent_state_changed handler delivers a proactive greeting on session start.
#
# Session context: resolve_session() reads household_id, trigger, task_instance_id and
# device_id from participant metadata. When a
# task instance triggered the session, the agent opens with that task's spoken prompt.
# Session context is also persisted to the conversations row via create_conversation().
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
# Last modified: 2026-10-29 (Convex backend)

import asyncio
import json
import logging
import re
from collections.abc import Awaitable, Callable

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
    LLM_MODEL,
    MAX_ENDPOINTING_DELAY,
    MIN_ENDPOINTING_DELAY,
    MIN_INTERRUPTION_DURATION,
    MIN_INTERRUPTION_WORDS,
    STT_LANGUAGE,
    STT_MODEL,
    TTS_VOICE,
)
from convex_client import ConvexClient, create_convex_client
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
    db_list_today,
)

logger = logging.getLogger("agent")

load_dotenv(".env")


class Assistant(Agent):
    """
    purpose: Voice assistant agent for the senior. Exposes tools for web search,
             today's tasks (list, confirm), senior-created reminders, contact lookup,
             and SMS messaging over iOS RPC.
    """

    def __init__(
        self,
        instructions: str,
        household_id: str | None,
        convex: ConvexClient,
        timezone: str = DEFAULT_TIMEZONE,
    ) -> None:
        """
        purpose: Initialize the Assistant with a pre-rendered system prompt and the
                 Convex client + household needed for the task tools.
        @param instructions: (str) The fully rendered system prompt from render_system_prompt().
        @param household_id: (str | None) Household id; None disables the task tools.
        @param convex: (ConvexClient) Convex client carrying the agent key.
        @param timezone: (str) IANA timezone of the household, used to phrase dates.
        """
        super().__init__(instructions=instructions)
        self._household_id = household_id
        self._convex = convex
        self._timezone = timezone
        self.tavily_client = TavilyClient()

    @function_tool
    async def web_search(self, context: RunContext, query: str):
        """
        purpose: Look up information on the web using Tavily search.

        Args:
            query: The search query to look up

        Returns:
            The search results or an error message
        """
        logger.info(f"Looking up information on {query}")
        await context.session.say(
            "I'm looking up information on that topic. Please wait a moment."
        )
        try:
            response = self.tavily_client.search(query, include_answer="basic")
            logger.info(f"Answer: {response.get('answer')}")
            return response.get("answer", "No results found for that query.")
        except Exception as e:
            logger.error(f"Error looking up information on {query}: {e}")
            return "I'm sorry, I'm having trouble with my web search right now. Please try again later."

    @function_tool
    async def find_contact(self, context: RunContext, query: str):
        """
        purpose: Find contacts matching a search query via iOS RPC.

        Args:
            query: The search string to match against contact names

        Returns:
            List of matching contacts with names and phone numbers
        """
        logger.info(f"Finding contacts for query: {query}")
        await context.session.say("Let me search your contacts.")

        try:
            from livekit.agents import get_job_context

            room = get_job_context().room
            participant_identity = next(iter(room.remote_participants))

            search_data = {"query": query}

            response = await room.local_participant.perform_rpc(
                destination_identity=participant_identity,
                method="findContact",
                payload=json.dumps(search_data),
                response_timeout=10.0,
            )

            logger.info(f"Contact search response: {response}")
            contacts = json.loads(response)

            if not contacts:
                return f"I couldn't find any contacts matching '{query}'. Please try a different name."
            elif len(contacts) == 1:
                contact = contacts[0]
                return (
                    f"I found {contact['name']} with phone number {contact['phone']}."
                )
            else:
                contact_list = ", ".join(
                    [f"{c['name']} ({c['phone']})" for c in contacts[:3]]
                )
                if len(contacts) > 3:
                    contact_list += f" and {len(contacts) - 3} more"
                return f"I found {len(contacts)} contacts: {contact_list}. Which one would you like to message?"

        except Exception as e:
            logger.error(f"Error finding contacts: {e}")
            return "I'm sorry, I couldn't search your contacts right now. Please try again."

    @function_tool
    async def send_message(
        self, context: RunContext, contact_name: str, phone_number: str, message: str
    ):
        """
        purpose: Send a message to a contact via iOS RPC.

        Args:
            contact_name: The name of the contact (for confirmation)
            phone_number: The recipient's phone number
            message: The message content to send

        Returns:
            Confirmation message or error
        """
        logger.info(f"Sending message to {contact_name} ({phone_number}): {message}")
        await context.session.say(f"I'll send that message to {contact_name}.")

        try:
            from livekit.agents import get_job_context

            room = get_job_context().room
            participant_identity = next(iter(room.remote_participants))

            message_data = {
                "contactId": "",
                "phoneNumber": phone_number,
                "message": message,
            }

            response = await room.local_participant.perform_rpc(
                destination_identity=participant_identity,
                method="sendMessage",
                payload=json.dumps(message_data),
                response_timeout=10.0,
            )

            logger.info(f"Message send response: {response}")
            return f"I've opened the message composer to send '{message}' to {contact_name}. Please review and send."

        except Exception as e:
            logger.error(f"Error sending message: {e}")
            return "I'm sorry, I couldn't send that message. Please try again."

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
        return await self._household_tool(
            "record that",
            lambda h: db_confirm_task(self._convex, h, self._timezone, task_name),
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
                 plumber tomorrow at 10". Family caregivers can see it in their app.

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


def _is_garbage_input(text: str) -> bool:
    """
    purpose: Return True if an STT transcript is too short or contains no alphabetic
             characters, indicating noise (cough, TV, short sound) rather than speech.
    @param text: (str) Stripped transcript string from the STT engine.
    @return: (bool) True if the input should be discarded without LLM processing.
    """
    return len(text) < 3 or not any(c.isalpha() for c in text)


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
             Also registers error recovery, STT garbage filter, participant reconnect,
             and proactive greeting handlers so the agent never goes silent.
             When a task instance triggered the session, that task's spoken prompt
             overrides the default welcome message.
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
    conv_logger = ConversationLogger(convex, conversation_id)
    shutdown_logger = conv_logger

    # 4. Task-triggered sessions open with the task's fixed spoken prompt
    name_part = f", {user_name}" if user_name else ""
    initial_greeting: str | None = None
    if session_instance_id:
        instance = next(
            (
                i
                for i in raw_context.get("today", [])
                if i.get("instanceId") == session_instance_id
            ),
            None,
        )
        if instance and instance.get("state") not in ("confirmed", "resolved"):
            initial_greeting = instance.get("spokenPrompt") or (
                f"It's time for {instance.get('displayLabel', 'your task')}."
            )
            logger.info(f"Task prompt greeting: {initial_greeting!r}")

    # 5. Render system prompt with injected household context
    context_block = format_user_context(raw_context)
    rendered_prompt = render_system_prompt(context_block)
    logger.info(f"System prompt rendered for household_id={household_id}")

    # 6. Build session with senior-optimized voice UX parameters
    session = AgentSession(
        stt=deepgram.STT(model=STT_MODEL, language=STT_LANGUAGE),
        llm=anthropic.LLM(model=LLM_MODEL),
        tts=cartesia.TTS(voice=TTS_VOICE),
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

    # 7. State variables for error recovery and reconnect detection
    consecutive_errors = 0
    last_disconnect_time: float | None = None
    last_topic: str = ""
    _greeted = False
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

    # 11. Proactive greeting — speak once when session becomes idle and user isn't already talking
    @session.on("agent_state_changed")
    def _on_agent_state_changed(ev):
        """
        purpose: Deliver a proactive greeting the first time the agent reaches idle state,
                 but only if no conversation has occurred yet. If the user spoke before the
                 agent finished initializing, session.history will already contain messages
                 and the greeting is skipped to avoid overriding the response in progress.
                 When initial_greeting is set (task-triggered sessions), speaks the task's
                 fixed prompt instead of the generic welcome.
        @param ev: Event with .new_state (str) indicating the agent's new pipeline state.
        """
        nonlocal _greeted
        if ev.new_state == "idle" and not _greeted:
            _greeted = True
            # Skip greeting if a conversation has already started (user spoke first)
            history_has_messages = len(session.history.items) > 0
            if session.user_state != "speaking" and not history_has_messages:
                greeting = initial_greeting or (
                    f"Hi{name_part}! I'm Sunny, your personal helper. "
                    "I can help you with reminders, answer questions, or just have a chat. "
                    "What's on your mind?"
                )
                session.say(greeting)

    # 12. Participant disconnect — record disconnect time and last topic for reconnect greeting
    def _on_participant_disconnected(participant):
        """
        purpose: Record the disconnect timestamp and last assistant message so the
                 agent can greet the user with context on a quick reconnect.
        @param participant: The disconnected LiveKit participant object.
        """
        nonlocal last_disconnect_time, last_topic
        last_disconnect_time = asyncio.get_running_loop().time()
        history = [
            i
            for i in session.history.items
            if isinstance(i, ChatMessage) and i.role == "assistant"
        ]
        last_topic = history[-1].text_content[:80] if history else ""
        logger.info(
            f"Participant {participant.identity} disconnected (household={household_id})"
        )
        asyncio.create_task(conv_logger.finalize(session.history))  # noqa: RUF006

    # 13. Participant reconnect — greet returning user within 10-minute window
    def _on_participant_connected(participant):
        """
        purpose: Greet the user with their last topic if they reconnect within 10 minutes.
                 Skips silently on first join (last_disconnect_time is None until a disconnect occurs).
        @param participant: The reconnected LiveKit participant object.
        """
        nonlocal last_disconnect_time, last_topic
        if last_disconnect_time is None:
            return  # first connection, not a reconnect
        elapsed = asyncio.get_running_loop().time() - last_disconnect_time
        if elapsed < 600:  # 10-minute reconnect window
            topic_suffix = (
                f" We were talking about: {last_topic}." if last_topic else ""
            )
            greeting = (
                f"Welcome back{', ' + user_name if user_name else ''}!{topic_suffix}"
            )
            session.say(greeting)
        last_disconnect_time = None

    ctx.room.on("participant_disconnected", _on_participant_disconnected)
    ctx.room.on("participant_connected", _on_participant_connected)

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
    )

    # 17. Start session — room is already connected, session.start() will not reconnect
    await session.start(
        agent=_assistant,
        room=ctx.room,
        room_input_options=RoomInputOptions(
            noise_cancellation=noise_cancellation.BVC(),
        ),
    )


if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint, prewarm_fnc=prewarm))
