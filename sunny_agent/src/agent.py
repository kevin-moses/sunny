import asyncio
import json
import logging
import re
from collections.abc import AsyncGenerator, Awaitable, Callable
from typing import Annotated, Literal, TypedDict

from dotenv import load_dotenv
from livekit import rtc
from livekit.agents import (
    NOT_GIVEN,
    Agent,
    AgentFalseInterruptionEvent,
    AgentSession,
    AgentStateChangedEvent,
    ConversationItemAddedEvent,
    ErrorEvent,
    JobContext,
    JobProcess,
    MetricsCollectedEvent,
    ModelSettings,
    RoomInputOptions,
    RunContext,
    UserInputTranscribedEvent,
    UserStateChangedEvent,
    WorkerOptions,
    cli,
    metrics,
)
from livekit.agents.llm import ChatChunk, ChatContext, ChatMessage, Tool, function_tool
from livekit.plugins import anthropic, cartesia, deepgram, noise_cancellation, silero
from livekit.plugins.turn_detector.multilingual import MultilingualModel
from pydantic import Field
from tavily import TavilyClient

from config import (
    ECHO_DETECTION_WINDOW_S,
    INACTIVITY_CHECK_S,
    INACTIVITY_TIMEOUT_S,
    LLM_MODEL,
    MAX_ENDPOINTING_DELAY,
    MIN_ENDPOINTING_DELAY,
    MIN_INTERRUPTION_DURATION,
    MIN_INTERRUPTION_WORDS,
    NO_HOUSEHOLD_TIMEZONE,
    STT_LANGUAGE,
    STT_MODEL,
    TTS_MODEL,
    TTS_SPEED,
    TTS_VOICE,
)
from convex_client import ConvexApi, create_convex_client
from convex_types import AgentContext, TodayEntry
from list_tools import db_add_to_list, db_read_list, db_take_off_list
from memory import (
    ConversationLogger,
    create_conversation,
    load_agent_context,
    resolve_session,
    shutdown_conversation,
)
from prompts import format_user_context, render_system_prompt
from speech_guard import (
    FORCE_FLAG,
    UNREACHED_LINE,
    another_is_hers,
    review_reply,
)
from tools import (
    ANYTIME,
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
    one_line,
    step_speech,
)
from weather import Place, WeatherError, lookup_place, weather_report

logger = logging.getLogger("agent")

load_dotenv(".env")

ModelFlagReason = Literal[
    "symptom",
    "money_request",
    "scam",
    "distress",
    "help_requested",
]


class Assistant(Agent):
    def __init__(
        self,
        instructions: str,
        household_id: str | None,
        convex: ConvexApi,
        timezone: str = NO_HOUSEHOLD_TIMEZONE,
        conversation_id: str = "",
        weather_location: str | None = None,
        prompt_label: str = "",
    ) -> None:
        super().__init__(instructions=instructions)
        self._household_id = household_id
        self._convex = convex
        self._timezone = timezone
        self._conversation_id = conversation_id or None
        self._weather_location = (weather_location or "").strip()
        self._weather_place: Place | None = None
        self._prompt_label = prompt_label
        self._tavily: TavilyClient | None = None
        self._another_is_hers = False

    async def llm_node(
        self,
        chat_ctx: ChatContext,
        tools: list[Tool],
        model_settings: ModelSettings,
    ) -> AsyncGenerator[ChatChunk | str, None]:
        self._another_is_hers = another_is_hers(chat_ctx)
        chunks = [
            chunk
            async for chunk in Agent.default.llm_node(
                self, chat_ctx, tools, model_settings
            )
            if isinstance(chunk, ChatChunk)
        ]
        if _has_tool_call(chunks):
            for chunk in _without_text(chunks):
                yield chunk
            return

        text = "".join(c.delta.content or "" for c in chunks if c.delta)
        verdict = review_reply(text, chat_ctx)
        if verdict is FORCE_FLAG:
            logger.warning(
                "Reply said family was told without a tool call; forcing flag_caregiver"
            )
            forced: list[ChatChunk] = []
            try:
                forced = [
                    chunk
                    async for chunk in Agent.default.llm_node(
                        self,
                        chat_ctx,
                        tools,
                        ModelSettings(
                            tool_choice={
                                "type": "function",
                                "function": {"name": "flag_caregiver"},
                            }
                        ),
                    )
                    if isinstance(chunk, ChatChunk)
                ]
            except Exception:
                logger.exception("Forced flag_caregiver call failed")
            for chunk in _without_text(chunks + forced):
                yield chunk
            if not _has_tool_call(forced):
                yield UNREACHED_LINE
            return

        if verdict == text:
            for chunk in chunks:
                yield chunk
            return
        logger.warning("Reply replaced by the speech guard")
        for chunk in _without_text(chunks):
            yield chunk
        yield verdict

    @function_tool(
        description="Look up current information on the web using Tavily search."
    )
    async def web_search(
        self,
        context: RunContext,
        query: Annotated[str, Field(description="The search query to look up")],
    ) -> str:
        logger.info(f"Looking up information on {query}")
        await context.session.say("Let me look that up.")
        try:
            if self._tavily is None:
                self._tavily = TavilyClient()
            response = await asyncio.to_thread(
                self._tavily.search, query, include_answer="basic"
            )
            answer = response.get("answer")
            logger.info(f"Answer: {answer}")
            return answer or "No results found for that query."
        except Exception as e:
            logger.error(f"Error looking up information on {query}: {e}")
            return "The web search is not working right now, so this could not be looked up."

    @function_tool(
        description=(
            "Current weather and today's hourly forecast (temperature, conditions, chance "
            "of rain by hour) for the household's location. Use the hour of a scheduled "
            'activity to answer questions like "Do I need an umbrella for my walk?".'
        )
    )
    async def get_weather(self, context: RunContext) -> str:
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
        if not self._household_id:
            return f"I can't {what} right now."
        try:
            return await call(self._household_id)
        except Exception as e:
            logger.error(f"Error trying to {what}: {e}")
            return f"I'm sorry, I had trouble trying to {what}."

    @function_tool(
        description=(
            "Read today's schedule and what has already been done, so questions like "
            '"Did I take my pills?" or "What\'s next today?" are answered from the '
            "household's live state rather than memory."
        )
    )
    async def list_today(self, context: RunContext) -> str:
        return await self._household_tool(
            "check today's schedule",
            lambda h: db_list_today(self._convex, h, self._timezone),
        )

    @function_tool(
        description=(
            'Record that the senior did a task ("I took them", "done"). Confirms the '
            "matching task on today's schedule, or the one due now when no name is "
            "given. If it was already confirmed, returns when, so the senior is never "
            "told to repeat a dose. A task with steps is done one step at a time: each "
            "call marks the current step done and returns the next step to read out; "
            "pass the step number you last read out for it. "
            "Only call when the senior clearly says they did it."
        )
    )
    async def confirm_task(
        self,
        context: RunContext,
        task_name: Annotated[
            str,
            Field(
                description=(
                    'Name or part of the task\'s label, e.g. "morning pills"; empty for '
                    "whatever is due now"
                )
            ),
        ] = "",
        step: Annotated[
            int,
            Field(
                description=(
                    "For a task with steps, the step number you last read out for it, e.g. 2 "
                    'for "Step 2 of 3"; 0 when you did not read a step'
                ),
                ge=0,
            ),
        ] = 0,
    ) -> str:
        label = task_name or self._prompt_label
        return await self._household_tool(
            "record that",
            lambda h: db_confirm_task(self._convex, h, self._timezone, label, step),
        )

    @function_tool(
        description=(
            '"Not yet", "later", "in a minute" about a task: snooze its reminders for 15 '
            "minutes. Family alerts are not delayed."
        )
    )
    async def snooze_task(
        self,
        context: RunContext,
        task_name: Annotated[
            str,
            Field(
                description=(
                    "Name or part of the task's label; empty for whatever is due now"
                )
            ),
        ] = "",
    ) -> str:
        label = task_name or self._prompt_label
        return await self._household_tool(
            "snooze that",
            lambda h: db_snooze_task(self._convex, h, self._timezone, label),
        )

    @function_tool(
        description=(
            'Fresh facts for any medication question ("Can I take another pill?", "Did I '
            "take my pills?\"): today's scheduled medications and when they were taken, "
            "and for each as-needed medication the label limits, doses taken today and "
            "when another would be within the label."
        )
    )
    async def medication_status(self, context: RunContext) -> str:
        return await self._household_tool(
            "check the medications",
            lambda h: db_medication_status(self._convex, h, self._timezone),
        )

    @function_tool(
        description=(
            'Record that the senior took an as-needed medication ("I took a Tylenol"). '
            "Call it once per dose. Returns the label facts afterwards; family is told "
            "automatically if the dose is past a label limit. If one is already written "
            "down close to it, nothing is logged and the result says to ask whether it is "
            "the same one or another. Only for as-needed medications, never for scheduled "
            'ones like "my pills" (use confirm_task).'
        )
    )
    async def log_dose(
        self,
        context: RunContext,
        medication: Annotated[
            str,
            Field(
                description=(
                    'Words naming the medication, e.g. "pain reliever"; empty if only '
                    "one as-needed medication is on file"
                )
            ),
        ] = "",
        minutes_ago: Annotated[
            int,
            Field(description="How many minutes ago they took it; 0 for just now"),
        ] = 0,
        another: Annotated[
            bool,
            Field(
                description=(
                    "True only when they said this is another dose, not the one already "
                    'written down ("No, I took another one")'
                )
            ),
        ] = False,
    ) -> str:
        confirmed_another = another and self._another_is_hers
        return await self._household_tool(
            "log that",
            lambda h: db_log_dose(
                self._convex,
                h,
                self._timezone,
                medication,
                minutes_ago,
                self._conversation_id,
                confirmed_another,
            ),
        )

    @function_tool(
        description=(
            "Take back an as-needed dose they reported earlier in this conversation and "
            'did not actually take ("No, I didn\'t take it after all"). Doses from earlier '
            "conversations cannot be changed here. Family is told if they had been told."
        )
    )
    async def undo_last_dose(
        self,
        context: RunContext,
        medication: Annotated[
            str,
            Field(
                description=(
                    "Words naming the medication; empty for the last one they reported"
                )
            ),
        ] = "",
    ) -> str:
        return await self._household_tool(
            "take that back",
            lambda h: db_undo_last_dose(
                self._convex, h, self._timezone, medication, self._conversation_id
            ),
        )

    @function_tool(
        description=(
            "Add things to the household's shared list, which family can see (\"Add milk "
            'and eggs to the list"). Call it right away with every item they named; no '
            "confirmation is needed."
        )
    )
    async def add_to_list(
        self,
        context: RunContext,
        items: Annotated[
            list[str],
            Field(description='Each item separately, short, e.g. ["milk", "eggs"]'),
        ],
    ) -> str:
        return await self._household_tool(
            "add that to the list",
            lambda h: db_add_to_list(self._convex, h, items),
        )

    @function_tool(description='Read the household list ("What\'s on my list?").')
    async def read_list(self, context: RunContext) -> str:
        return await self._household_tool(
            "read the list", lambda h: db_read_list(self._convex, h)
        )

    @function_tool(
        description=(
            'Take an item off the list when they got it or no longer need it ("I bought '
            'the milk").'
        )
    )
    async def take_off_list(
        self,
        context: RunContext,
        item: Annotated[str, Field(description='The item, e.g. "milk"')],
    ) -> str:
        return await self._household_tool(
            "update the list", lambda h: db_take_off_list(self._convex, h, item)
        )

    @function_tool(
        description=(
            'Create a reminder the senior asked for, e.g. "remind me to call the plumber '
            'tomorrow at 10". Family caregivers can see it in their app. Call it right '
            "away; no confirmation is needed."
        )
    )
    async def create_reminder(
        self,
        context: RunContext,
        title: Annotated[
            str,
            Field(
                description=(
                    'What to remind them about, phrased to follow "remind you to", e.g. '
                    '"call the plumber"'
                )
            ),
        ],
        time: Annotated[str, Field(description='24-hour time, e.g. "10:00"')],
        on_date: Annotated[
            str,
            Field(
                description=(
                    'Date "YYYY-MM-DD" for a one-time reminder; empty for a recurring one'
                )
            ),
        ] = "",
        days: Annotated[
            list[str] | None,
            Field(
                description=(
                    'For recurring reminders, day abbreviations like ["mon","wed"]; '
                    "empty means every day"
                )
            ),
        ] = None,
    ) -> str:
        logger.info(f"Creating senior reminder: {title} at {time} on {on_date or days}")
        return await self._household_tool(
            "save that reminder",
            lambda h: db_create_senior_reminder(
                self._convex, h, self._timezone, title, time, on_date, days
            ),
        )

    @function_tool(
        description=(
            "Cancel a reminder the senior created earlier, by title. Reminders and tasks "
            "set up by family cannot be cancelled here."
        )
    )
    async def cancel_reminder(
        self,
        context: RunContext,
        reminder_title: Annotated[
            str,
            Field(description="The name or part of the name of the reminder to cancel"),
        ],
    ) -> str:
        return await self._household_tool(
            "cancel that reminder",
            lambda h: db_cancel_senior_reminder(self._convex, h, reminder_title),
        )

    @function_tool(
        description=(
            'Remember something the senior says ("Remember that...", "I put my glasses in '
            'the hall drawer"). Stored as unverified until family confirms it; it never '
            "changes anything family wrote."
        )
    )
    async def remember_fact(
        self,
        context: RunContext,
        fact: Annotated[
            str,
            Field(
                description=(
                    'The fact as a full sentence with names, e.g. "Margaret put her '
                    'glasses in the hall drawer."'
                )
            ),
        ],
    ) -> str:
        return await self._household_tool(
            "note that",
            lambda h: db_remember_fact(self._convex, h, fact, self._conversation_id),
        )

    @function_tool(
        description=(
            "Let family know something needs their attention: a new or repeated symptom, "
            "someone asking for money, anything that sounds like a scam, signs of distress "
            "(a fall is distress: it is urgent), or the senior asking for family. Call "
            "once per concern; a new or worse event is a new concern."
        )
    )
    async def flag_caregiver(
        self,
        context: RunContext,
        reason: Annotated[
            ModelFlagReason,
            Field(description="The kind of concern; use distress for a fall"),
        ],
        detail: Annotated[
            str,
            Field(
                description=(
                    "At most two short plain sentences for the caregiver about what "
                    "happened. Never include card, bank or account numbers."
                )
            ),
        ],
    ) -> str:
        return await self._household_tool(
            "reach your family",
            lambda h: db_flag_caregiver(
                self._convex, h, reason, detail, self._conversation_id
            ),
        )

    @function_tool(
        description=(
            'Send a message from the senior to family through the Sunny app ("Tell Sarah '
            "I'm home\"). Read the message back and get a yes before calling."
        )
    )
    async def send_family_message(
        self,
        context: RunContext,
        message: Annotated[
            str,
            Field(description="The message in the senior's words, e.g. \"I'm home\""),
        ],
        to: Annotated[
            str,
            Field(
                description=(
                    'The name of the person it is for, e.g. "Sarah"; empty for the family'
                )
            ),
        ] = "",
    ) -> str:
        return await self._household_tool(
            "send that message",
            lambda h: db_send_family_message(
                self._convex, h, to, message, self._conversation_id
            ),
        )

    @function_tool(
        description=(
            'Read the newest message family sent ("What did Sarah send?", "Any '
            'messages?"). Marks it as read.'
        )
    )
    async def read_latest_message(self, context: RunContext) -> str:
        return await self._household_tool(
            "read the messages",
            lambda h: db_read_latest_message(self._convex, h, self._timezone),
        )


_FILLER_WORDS = {"uh", "um", "hm", "hmm", "mm", "mhm", "er", "ah", "eh", "oh"}


def _has_tool_call(chunks: list[ChatChunk]) -> bool:
    return any(c.delta and c.delta.tool_calls for c in chunks)


def _without_text(chunks: list[ChatChunk]) -> list[ChatChunk]:
    kept: list[ChatChunk] = []
    for chunk in chunks:
        if chunk.delta and chunk.delta.content:
            delta = chunk.delta.model_copy(update={"content": None})
            chunk = chunk.model_copy(update={"delta": delta})
        if chunk.usage or (chunk.delta and chunk.delta.tool_calls):
            kept.append(chunk)
    return kept


def _is_garbage_input(text: str) -> bool:
    words = re.findall(r"[^\W\d_]+", text.lower())
    if sum(len(w) for w in words) < 2:
        return True
    return all(w in _FILLER_WORDS for w in words)


_ECHO_BUFFER_MAX_ENTRIES = 50
_ECHO_NORMALIZE_RE = re.compile(r"[^a-z0-9 ]")
_ECHO_MULTISPACES_RE = re.compile(r" {2,}")


def _normalize_for_echo(text: str) -> str:
    stripped = _ECHO_NORMALIZE_RE.sub("", text.lower()).strip()
    return _ECHO_MULTISPACES_RE.sub(" ", stripped)


def _is_echo(
    text: str,
    recent_agent_texts: list[tuple[float, str]],
    now: float,
    window: float,
) -> bool:
    normalized = _normalize_for_echo(text)
    words = normalized.split()
    if not words:
        return False
    recent = [(ts, t) for ts, t in recent_agent_texts if now - ts <= window]
    if len(words) <= 2 and recent:
        last_words = max(recent)[1].split()
        if last_words[-len(words) :] == words:
            return True
    if len(words) < 2:
        return False
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
    if consecutive_errors == 1:
        return "I'm thinking about that — give me just a moment."
    elif consecutive_errors == 2:
        hint = f", {name}" if name else ""
        return f"I'm having a little trouble{hint}. Could you try saying that again?"
    else:
        return "I'm having some technical difficulties. You might want to try again in a few minutes."


_OPEN_FOR_CONFIRMATION_STATES = ("due", "escalated")


def _opening_prompt(
    context: AgentContext | None, task_instance_id: str | None
) -> tuple[str | None, str]:
    if not task_instance_id or context is None:
        return None, ""
    instance = next(
        (i for i in context["today"] if i["instanceId"] == task_instance_id),
        None,
    )
    if instance is None:
        return None, ""
    label = instance["displayLabel"]
    if instance["state"] not in _OPEN_FOR_CONFIRMATION_STATES:
        return None, label
    return _display_cue_speech(instance), label


def _display_cue_speech(instance: TodayEntry) -> str:
    base = _display_cue_base(instance)
    step = instance.get("step")
    return base if step is None else f"{base} {one_line(step_speech(step))}"


def _display_cue_base(instance: TodayEntry) -> str:
    label = instance["displayLabel"]
    spoken = instance["spokenPrompt"].strip()
    if spoken and spoken != f"Time for {label}.":
        return one_line(spoken)
    finish = "taken them" if instance["type"] == "medication" else "finished"
    scheduled = instance["scheduledTime"]
    when = "" if scheduled == ANYTIME else f", at {_display_cue_spoken_time(scheduled)}"
    return f"Time for {label}{when}. Press Done when you have {finish}."


def _display_cue_spoken_time(local_time: str) -> str:
    hour_text, _, minute = local_time.partition(":")
    if not hour_text.isdigit() or len(minute) != 2 or not minute.isdigit():
        return local_time
    hour = int(hour_text) % 12 or 12
    return f"{hour} o'clock" if minute == "00" else f"{hour}:{minute}"


APP_LOG_TOPIC = "ios.log"
_APP_LOG_LEVELS = {
    "DEBUG": logging.DEBUG,
    "INFO": logging.INFO,
    "WARNING": logging.WARNING,
    "ERROR": logging.ERROR,
}


class AppLogEntry(TypedDict):
    level: str
    component: str
    message: str
    metadata: dict[str, object]


def _parse_app_log(data: bytes) -> AppLogEntry | None:
    try:
        payload: object = json.loads(data)
    except ValueError:
        return None
    if not isinstance(payload, dict):
        return None
    level = payload.get("level")
    component = payload.get("component")
    message = payload.get("message")
    metadata = payload.get("metadata", {})
    if not (
        isinstance(level, str)
        and isinstance(component, str)
        and isinstance(message, str)
        and isinstance(metadata, dict)
    ):
        return None
    return {
        "level": level,
        "component": component,
        "message": message,
        "metadata": metadata,
    }


def _forward_app_log(packet: rtc.DataPacket) -> None:
    if packet.topic != APP_LOG_TOPIC:
        return
    entry = _parse_app_log(packet.data)
    if entry is None:
        logger.warning("dropped an app log packet that is not a valid log entry")
        return
    logging.getLogger(f"ios.{entry['component']}").log(
        _APP_LOG_LEVELS.get(entry["level"], logging.INFO),
        "%s",
        entry["message"],
        extra={"app": entry["metadata"]},
    )


def prewarm(proc: JobProcess) -> None:
    proc.userdata["vad"] = silero.VAD.load()


async def entrypoint(ctx: JobContext) -> None:
    ctx.log_context_fields = {"room": ctx.room.name}

    await ctx.connect()

    session_ctx = resolve_session(ctx.room)
    household_id = session_ctx.household_id
    session_instance_id = session_ctx.task_instance_id

    convex = create_convex_client()
    shutdown_logger: ConversationLogger | None = None
    history_source: Callable[[], ChatContext] | None = None

    async def _on_shutdown() -> None:
        await shutdown_conversation(
            convex.aclose,
            shutdown_logger,
            history_source() if history_source is not None else None,
        )

    ctx.add_shutdown_callback(_on_shutdown)

    raw_context, conversation_id = await asyncio.gather(
        load_agent_context(convex, household_id),
        create_conversation(
            convex,
            household_id,
            trigger=session_ctx.trigger,
            task_instance_id=session_instance_id,
            device_id=session_ctx.device_id,
        ),
    )
    if raw_context is None:
        user_name, household_timezone, weather_location = (
            "",
            NO_HOUSEHOLD_TIMEZONE,
            None,
        )
        recent_topics: list[str] = []
    else:
        household = raw_context["household"]
        user_name = household["seniorPreferredName"]
        household_timezone = household["timezone"]
        weather_location = household["weatherLocation"]
        recent_topics = raw_context["recentQuestionTopics"]
    conv_logger = ConversationLogger(convex, conversation_id, recent_topics)
    shutdown_logger = conv_logger

    initial_prompt, prompt_label = _opening_prompt(raw_context, session_instance_id)
    if initial_prompt:
        logger.info(f"Task prompt opening: {initial_prompt!r}")

    context_block = format_user_context(raw_context)
    rendered_prompt = render_system_prompt(context_block, user_name)
    logger.info(f"System prompt rendered for household_id={household_id}")

    session: AgentSession[None] = AgentSession(
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
        return session.history

    history_source = _session_history

    consecutive_errors = 0
    _opened = False
    activity = ActivityClock(asyncio.get_running_loop().time)

    @session.on("user_state_changed")
    def _on_user_state_changed(ev: UserStateChangedEvent) -> None:
        activity.touch()

    _recent_agent_texts: list[tuple[float, str]] = []

    @session.on("conversation_item_added")
    def _on_item_added(ev: ConversationItemAddedEvent) -> None:
        nonlocal consecutive_errors
        item = ev.item
        if isinstance(item, ChatMessage):
            if item.role == "assistant":
                consecutive_errors = 0
            if item.role in ("user", "assistant"):
                text = item.text_content
                if text:
                    conv_logger.track_log_message(item.role, text)
                    if item.role == "assistant":
                        if len(_recent_agent_texts) >= _ECHO_BUFFER_MAX_ENTRIES:
                            _recent_agent_texts.pop(0)
                        _recent_agent_texts.append(
                            (
                                asyncio.get_running_loop().time(),
                                _normalize_for_echo(text),
                            )
                        )

    @session.on("user_input_transcribed")
    def _on_user_input_transcribed(ev: UserInputTranscribedEvent) -> None:
        if not ev.is_final:
            return
        text = ev.transcript.strip()
        if _is_garbage_input(text):
            logger.info(
                f"Ignoring garbage STT input (household={household_id}): {text!r}"
            )
            session.interrupt()
            return
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

    @session.on("error")
    def _on_session_error(ev: ErrorEvent) -> None:
        nonlocal consecutive_errors
        consecutive_errors += 1
        logger.error(
            f"Session error #{consecutive_errors} (household={household_id}, "
            f"conversation={conversation_id}): {ev.error}"
        )
        try:
            session.say(_recovery_message(consecutive_errors, user_name))
        except RuntimeError:
            logger.warning(
                "session.say() failed in error handler; speech scheduler draining"
            )

    @session.on("agent_state_changed")
    def _on_agent_state_changed(ev: AgentStateChangedEvent) -> None:
        nonlocal _opened
        activity.touch()
        if ev.new_state != "idle" or _opened:
            return
        _opened = True
        if not initial_prompt:
            return
        if session.user_state != "speaking" and len(session.history.items) == 0:
            session.say(initial_prompt)

    def _on_participant_disconnected(participant: rtc.RemoteParticipant) -> None:
        logger.info(
            f"Participant {participant.identity} disconnected (household={household_id})"
        )
        conv_logger.start_finalize(session.history)

    ctx.room.on("participant_disconnected", _on_participant_disconnected)

    ctx.room.on("data_received", _forward_app_log)

    @session.on("agent_false_interruption")
    def _on_agent_false_interruption(ev: AgentFalseInterruptionEvent) -> None:
        logger.info("false positive interruption, resuming")
        try:
            session.generate_reply(instructions=ev.extra_instructions or NOT_GIVEN)
        except RuntimeError as e:
            logger.warning("Proactive generate_reply skipped: %s", e)

    usage_collector = metrics.UsageCollector()

    @session.on("metrics_collected")
    def _on_metrics_collected(ev: MetricsCollectedEvent) -> None:
        metrics.log_metrics(ev.metrics)
        usage_collector.collect(ev.metrics)

    async def _log_usage() -> None:
        summary = usage_collector.get_summary()
        logger.info(f"Usage: {summary}")

    ctx.add_shutdown_callback(_log_usage)

    _assistant = Assistant(
        instructions=rendered_prompt,
        household_id=household_id,
        convex=convex,
        timezone=household_timezone,
        conversation_id=conversation_id,
        weather_location=weather_location,
        prompt_label=prompt_label,
    )

    await session.start(
        agent=_assistant,
        room=ctx.room,
        room_input_options=RoomInputOptions(
            noise_cancellation=noise_cancellation.BVC(),
        ),
    )

    _inactivity_task = asyncio.create_task(
        watch_inactivity(
            session,
            lambda: ctx.shutdown(reason="inactive"),
            INACTIVITY_TIMEOUT_S,
            INACTIVITY_CHECK_S,
            activity,
        )
    )
    ctx.add_shutdown_callback(lambda: _cancel(_inactivity_task))


async def _cancel(task: asyncio.Task[None]) -> None:
    task.cancel()


class ActivityClock:
    def __init__(self, now: Callable[[], float]) -> None:
        self._now = now
        self.last = now()

    def touch(self) -> None:
        self.last = self._now()


async def watch_inactivity(
    session: AgentSession[None],
    end_session: Callable[[], object],
    timeout_s: float,
    check_s: float,
    activity: ActivityClock | None = None,
) -> None:
    loop = asyncio.get_running_loop()
    clock = activity or ActivityClock(loop.time)
    while True:
        await asyncio.sleep(check_s)
        busy = session.user_state == "speaking" or session.agent_state in (
            "speaking",
            "thinking",
        )
        if busy:
            clock.touch()
        elif loop.time() - clock.last >= timeout_s:
            logger.info(f"No speech for {timeout_s:.0f} s; ending the session")
            end_session()
            return


if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint, prewarm_fnc=prewarm))
