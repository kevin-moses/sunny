# agent.py
# Purpose: LiveKit voice agent for Sunny, a voice-first iOS accessibility assistant.
# Implements a Deepgram STT -> Claude Haiku LLM -> Cartesia TTS pipeline via LiveKit Agents.
# Loads per-user context from Supabase at session start, logs all conversation turns in
# real time, and generates a post-session summary stored back to Supabase on shutdown.
# Exposes tool functions for web search, reminders, contact lookup, and messaging,
# all delegated to the iOS app over LiveKit RPC. Also exposes save_reminder,
# list_reminders, and delete_reminder tools backed directly by the Supabase reminders table.
#
# Error handling: STT garbage filter silences short/non-alphabetic transcripts; progressive
# error recovery speaks escalating messages on LLM/STT/TTS failures; participant disconnect
# and reconnect handlers log session end and greet returning users within 10 minutes;
# agent_state_changed handler delivers a proactive greeting on session start.
#
# Last modified: 2026-02-22

import asyncio
import json
import logging

from dotenv import load_dotenv
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
from livekit.agents.llm import ChatMessage, function_tool
from livekit.plugins import anthropic, cartesia, deepgram, noise_cancellation, silero
from livekit.plugins.turn_detector.multilingual import MultilingualModel
from supabase import AsyncClient
from tavily import TavilyClient

from config import (
    LLM_MODEL,
    MAX_ENDPOINTING_DELAY,
    MIN_ENDPOINTING_DELAY,
    MIN_INTERRUPTION_DURATION,
    MIN_INTERRUPTION_WORDS,
    STT_LANGUAGE,
    STT_MODEL,
    TTS_VOICE,
)
from memory import (
    ConversationLogger,
    create_conversation,
    create_supabase_client,
    load_user_context,
    resolve_user_id,
)
from prompts import format_user_context, render_system_prompt
from tools import db_delete_reminder, db_list_reminders, db_save_reminder

logger = logging.getLogger("agent")

# Suppress noisy HTTP/2 header compression debug logs from the Supabase client transport
logging.getLogger("hpack").setLevel(logging.WARNING)

load_dotenv(".env")


class Assistant(Agent):
    """
    purpose: Voice assistant agent with senior-optimized persona and tool integrations
             for web search, reminders, contacts, and SMS messaging.
    """

    def __init__(self, instructions: str, user_id: str, supabase: AsyncClient) -> None:
        """
        purpose: Initialize the Assistant with a pre-rendered system prompt and
                 the Supabase client + user_id needed for reminder CRUD tools.
        @param instructions: (str) The fully rendered system prompt from render_system_prompt().
        @param user_id: (str) UUID of the current user, used for all DB reminder operations.
        @param supabase: (AsyncClient) Authenticated Supabase async client.
        """
        super().__init__(instructions=instructions)
        self._user_id = user_id
        self._supabase = supabase
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
        await context.session.say("I'm looking up information on that topic. Please wait a moment.")
        try:
            response = self.tavily_client.search(query, include_answer="basic")
            logger.info(f"Answer: {response.get('answer')}")
            return response.get("answer", "No results found for that query.")
        except Exception as e:
            logger.error(f"Error looking up information on {query}: {e}")
            return "I'm sorry, I'm having trouble with my web search right now. Please try again later."

    @function_tool
    async def create_reminder(self, context: RunContext, title: str, notes: str = "", due_date: str = ""):
        """
        purpose: Create a reminder in the user's Reminders app via iOS RPC.

        Args:
            title: The title of the reminder (required)
            notes: Optional notes for the reminder
            due_date: Optional due date in format "YYYY-MM-DD HH:MM" or "YYYY-MM-DD"

        Returns:
            Confirmation message or error
        """
        logger.info(f"Creating reminder: {title}")
        await context.session.say("I'll create that reminder for you.")

        try:
            from livekit.agents import get_job_context

            room = get_job_context().room
            participant_identity = next(iter(room.remote_participants))

            reminder_data = {
                "title": title,
                "notes": notes,
                "due_date": due_date,
            }

            response = await room.local_participant.perform_rpc(
                destination_identity=participant_identity,
                method="createReminder",
                payload=json.dumps(reminder_data),
                response_timeout=10.0,
            )

            logger.info(f"Reminder creation response: {response}")
            return f"Reminder '{title}' has been created successfully."

        except Exception as e:
            logger.error(f"Error creating reminder: {e}")
            return "I'm sorry, I couldn't create that reminder. Please try again."

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
                return f"I found {contact['name']} with phone number {contact['phone']}."
            else:
                contact_list = ", ".join([f"{c['name']} ({c['phone']})" for c in contacts[:3]])
                if len(contacts) > 3:
                    contact_list += f" and {len(contacts) - 3} more"
                return f"I found {len(contacts)} contacts: {contact_list}. Which one would you like to message?"

        except Exception as e:
            logger.error(f"Error finding contacts: {e}")
            return "I'm sorry, I couldn't search your contacts right now. Please try again."

    @function_tool
    async def send_message(self, context: RunContext, contact_name: str, phone_number: str, message: str):
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

    @function_tool
    async def save_reminder(
        self,
        context: RunContext,
        type: str,
        title: str,
        description: str,
        times: list[str],
        days: list[str],
    ) -> str:
        """
        purpose: Save a reminder to Sunny's reminder system (Supabase), which will
                 trigger push notifications at the scheduled time. Use for medication,
                 appointments, exercise, or any recurring wellness reminders.

        Args:
            type: Category of reminder: 'medication'|'appointment'|'exercise'|'wellness_checkin'|'custom'
            title: Short label for the reminder, e.g. "blood pressure medication"
            description: Optional additional detail (use empty string if none)
            times: 24-hour time strings, e.g. ["09:00", "21:00"]
            days: Day abbreviations, e.g. ["mon","tue","wed","thu","fri","sat","sun"]

        Returns:
            Voice-friendly confirmation message
        """
        logger.info(f"Saving reminder: {title} at {times} on {days}")
        try:
            return await db_save_reminder(
                self._supabase, self._user_id, type, title, description, times, days
            )
        except Exception as e:
            logger.error(f"Error saving reminder '{title}': {e}")
            return "I'm sorry, I had trouble saving that reminder. Please try again."

    @function_tool
    async def list_reminders(self, context: RunContext) -> str:
        """
        purpose: List all of the user's active reminders stored in Sunny's system.

        Returns:
            Voice-friendly string listing all active reminders, or a message if none exist
        """
        logger.info(f"Listing reminders for user {self._user_id}")
        try:
            return await db_list_reminders(self._supabase, self._user_id)
        except Exception as e:
            logger.error(f"Error listing reminders: {e}")
            return "I'm sorry, I had trouble fetching your reminders. Please try again."

    @function_tool
    async def delete_reminder(self, context: RunContext, reminder_title: str) -> str:
        """
        purpose: Cancel an active reminder in Sunny's system by title.
                 Uses a case-insensitive substring match. If multiple reminders match,
                 lists them and asks the user to clarify.

        Args:
            reminder_title: The name or partial name of the reminder to cancel

        Returns:
            Voice-friendly confirmation, not-found message, or clarification request
        """
        logger.info(f"Deleting reminder matching '{reminder_title}' for user {self._user_id}")
        try:
            status, matches = await db_delete_reminder(
                self._supabase, self._user_id, reminder_title
            )
            if status == "not_found":
                return (
                    f"I couldn't find a reminder matching '{reminder_title}'. "
                    "Would you like me to list your reminders?"
                )
            if status == "deleted":
                title = matches[0].get("title", reminder_title)
                return f"Done, I've cancelled your {title} reminder."
            # ambiguous
            names = ", ".join(r.get("title", "") for r in matches)
            return f"I found a few reminders that match: {names}. Which one would you like to cancel?"
        except Exception as e:
            logger.error(f"Error deleting reminder '{reminder_title}': {e}")
            return "I'm sorry, I had trouble cancelling that reminder. Please try again."


def _is_garbage_input(text: str) -> bool:
    """
    purpose: Return True if an STT transcript is too short or contains no alphabetic
             characters, indicating noise (cough, TV, short sound) rather than speech.
    @param text: (str) Stripped transcript string from the STT engine.
    @return: (bool) True if the input should be discarded without LLM processing.
    """
    return len(text) < 3 or not any(c.isalpha() for c in text)


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
             metadata is available, then loads user context from Supabase, builds
             the system prompt, and starts the voice pipeline with senior-optimized
             UX parameters and real-time conversation logging.
             Also registers error recovery, STT garbage filter, participant reconnect,
             and proactive greeting handlers so the agent never goes silent.
    @param ctx: (JobContext) LiveKit job context providing room access and lifecycle hooks.
    """
    ctx.log_context_fields = {"room": ctx.room.name}

    # 1. Connect first — gives us access to participant metadata before building the prompt
    await ctx.connect()

    # 2. Resolve user_id from participant metadata (or fallback)
    user_id = resolve_user_id(ctx.room)

    # 3. Init Supabase, load context, create conversation row
    supabase = await create_supabase_client()
    raw_context = await load_user_context(supabase, user_id)
    conversation_id = await create_conversation(supabase, user_id)
    conv_logger = ConversationLogger(supabase, user_id, conversation_id)
    user_name = raw_context.get("profile", {}).get("name", "")

    # 4. Render system prompt with injected user context
    context_block = format_user_context(raw_context)
    rendered_prompt = render_system_prompt(context_block)
    logger.info(f"System prompt rendered for user_id={user_id}")

    # 5. Build session with senior-optimized voice UX parameters
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

    # 6. State variables for error recovery and reconnect detection
    consecutive_errors = 0
    last_disconnect_time: float | None = None
    last_topic: str = ""
    _greeted = False

    # 7. Real-time message logging — fires on every completed conversation turn
    @session.on("conversation_item_added")
    def _on_item_added(ev: ConversationItemAddedEvent):
        """
        purpose: Handle conversation_item_added events to log each turn to Supabase
                 and reset the error streak counter on any successful assistant reply.
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
                    asyncio.create_task(conv_logger.log_message(item.role, text))

    # 8. STT garbage filter — silently discard noise before the LLM responds
    @session.on("user_input_transcribed")
    def _on_user_input_transcribed(ev):
        """
        purpose: Discard short or non-alphabetic STT transcripts (coughs, TV, brief noise)
                 before the LLM generates a response, keeping the session silent for noise.
        @param ev: Event with .is_final (bool) and .transcript (str).
        """
        if not ev.is_final:
            return
        text = ev.transcript.strip()
        if _is_garbage_input(text):
            logger.info(f"Ignoring garbage STT input (user={user_id}): {repr(text)}")
            session.interrupt()

    # 9. Progressive error recovery — speak an escalating message on pipeline failures
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
            f"Session error #{consecutive_errors} (user={user_id}, "
            f"conversation={conversation_id}): {ev.error}"
        )
        asyncio.create_task(session.say(_recovery_message(consecutive_errors, user_name)))

    # 10. Proactive greeting — speak once when session becomes idle and user isn't already talking
    @session.on("agent_state_changed")
    def _on_agent_state_changed(ev):
        """
        purpose: Deliver a proactive greeting the first time the agent reaches idle state.
                 Skipped if VAD has already detected the user speaking first.
        @param ev: Event with .new_state (str) indicating the agent's new pipeline state.
        """
        nonlocal _greeted
        if ev.new_state == "idle" and not _greeted:
            _greeted = True
            if session.user_state != "speaking":
                name_part = f", {user_name}" if user_name else ""
                asyncio.create_task(session.say(
                    f"Hi{name_part}! I'm Sunny, your personal helper. "
                    "I can help you with reminders, answer questions, or just have a chat. "
                    "What's on your mind?"
                ))

    # 11. Participant disconnect — record disconnect time and last topic for reconnect greeting
    def _on_participant_disconnected(participant):
        """
        purpose: Record the disconnect timestamp and last assistant message so the
                 agent can greet the user with context on a quick reconnect.
        @param participant: The disconnected LiveKit participant object.
        """
        nonlocal last_disconnect_time, last_topic
        last_disconnect_time = asyncio.get_event_loop().time()
        history = [
            i for i in session.history.items
            if isinstance(i, ChatMessage) and i.role == "assistant"
        ]
        last_topic = history[-1].text_content[:80] if history else ""
        logger.info(f"Participant {participant.identity} disconnected (user={user_id})")
        asyncio.create_task(conv_logger.finalize(session.history))

    # 12. Participant reconnect — greet returning user within 10-minute window
    def _on_participant_connected(participant):
        """
        purpose: Greet the user with their last topic if they reconnect within 10 minutes.
                 Skips silently on first join (last_disconnect_time is None until a disconnect occurs).
        @param participant: The reconnected LiveKit participant object.
        """
        nonlocal last_disconnect_time, last_topic
        if last_disconnect_time is None:
            return  # first connection, not a reconnect
        elapsed = asyncio.get_event_loop().time() - last_disconnect_time
        if elapsed < 600:  # 10-minute reconnect window
            topic_suffix = f" We were talking about: {last_topic}." if last_topic else ""
            greeting = f"Welcome back{', ' + user_name if user_name else ''}!{topic_suffix}"
            asyncio.create_task(session.say(greeting))
        last_disconnect_time = None

    ctx.room.on("participant_disconnected", _on_participant_disconnected)
    ctx.room.on("participant_connected", _on_participant_connected)

    # 13. False interruption recovery — resume agent speech after background noise
    @session.on("agent_false_interruption")
    def _on_agent_false_interruption(ev: AgentFalseInterruptionEvent):
        """
        purpose: Resume agent speech after a false positive interruption (e.g. cough, TV noise).
        @param ev: (AgentFalseInterruptionEvent) Event with optional extra instructions.
        """
        logger.info("false positive interruption, resuming")
        session.generate_reply(instructions=ev.extra_instructions or NOT_GIVEN)

    # 14. Metrics collection
    usage_collector = metrics.UsageCollector()

    @session.on("metrics_collected")
    def _on_metrics_collected(ev: MetricsCollectedEvent):
        """
        purpose: Collect and log pipeline performance metrics on each turn.
        @param ev: (MetricsCollectedEvent) Event containing the metrics snapshot.
        """
        metrics.log_metrics(ev.metrics)
        usage_collector.collect(ev.metrics)

    # 15. Shutdown callbacks — safety fallback for process-kill scenarios and usage logging
    #     (disconnect handler also calls finalize; both calling it is safe — finalize is idempotent)
    async def _on_shutdown():
        """
        purpose: Finalize the conversation record as a safety fallback for clean shutdowns
                 (job process killed, server restart, etc.) when no disconnect event fires.
        """
        await conv_logger.finalize(session.history)

    async def _log_usage():
        """
        purpose: Log aggregate token/audio usage after the session ends.
        """
        summary = usage_collector.get_summary()
        logger.info(f"Usage: {summary}")

    ctx.add_shutdown_callback(_on_shutdown)
    ctx.add_shutdown_callback(_log_usage)

    # 16. Start session — room is already connected, session.start() will not reconnect
    await session.start(
        agent=Assistant(instructions=rendered_prompt, user_id=user_id, supabase=supabase),
        room=ctx.room,
        room_input_options=RoomInputOptions(
            noise_cancellation=noise_cancellation.BVC(),
        ),
    )


if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint, prewarm_fnc=prewarm))
