# agent.py
# Purpose: LiveKit voice agent for Sunny, a voice-first iOS accessibility assistant.
# Implements a Deepgram STT -> Claude Haiku LLM -> Cartesia TTS pipeline via LiveKit Agents.
# Loads per-user context from Supabase at session start, logs all conversation turns in
# real time, and generates a post-session summary stored back to Supabase on shutdown.
# Exposes tool functions for web search, reminders, contact lookup, and messaging,
# all delegated to the iOS app over LiveKit RPC. Also exposes save_reminder,
# list_reminders, and delete_reminder tools backed directly by the Supabase reminders table.
# Exposes four guided workflow tools (start_workflow, confirm_step, go_back_step,
# exit_workflow) backed by WorkflowEngine, which now uses Supabase pgvector semantic
# search to find workflows and fetches steps from the DB (WF-4).
#
# Error handling: STT garbage filter silences short/non-alphabetic transcripts; progressive
# error recovery speaks escalating messages on LLM/STT/TTS failures; participant disconnect
# and reconnect handlers log session end and greet returning users within 10 minutes;
# agent_state_changed handler delivers a proactive greeting on session start.
#
# Session context (NOTIFY-1): resolve_session_context() reads trigger/reminder_id from
# participant metadata. When trigger == "notification_tap" and a reminder_id is present,
# the agent overrides the default greeting with a reminder-specific prompt so the user
# receives contextual check-in ("Time for your blood pressure medication. Did you take it?").
# Session context is also persisted to the conversations row via create_conversation().
#
# Screen share (SCREEN-3): entrypoint() registers track_subscribed / track_unsubscribed
# room event handlers. When the iOS broadcast extension publishes a video track,
# ScreenCapture.start_capture() opens a VideoStream and reads frames in a background
# asyncio task. Changed frames (perceptual hash Hamming distance > threshold) are stored
# as JPEG bytes. ScreenCapture is passed to Assistant so SCREEN-4 can inject frames into
# the LLM on each user turn. stop_capture() is also called on participant_disconnected as
# a guard against missed track_unsubscribed events on abrupt disconnects.
#
# Fixes applied: async Anthropic client in memory.py, user timezone in reminders,
# get_running_loop() replaces deprecated get_event_loop(), empty step_ids guard,
# reminder_type parameter rename, user_timezone threaded from profile,
# existing_profile_summary passed to ConversationLogger for merged profile generation.
#
# Last modified: 2026-02-28

import asyncio
import json
import logging

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
    resolve_session_context,
    resolve_user_id,
)
from prompts import format_step_context, format_user_context, render_system_prompt
from screen_capture import ScreenCapture
from tools import db_delete_reminder, db_list_reminders, db_save_reminder
from workflow_engine import WorkflowEngine, WorkflowState

logger = logging.getLogger("agent")

# Suppress noisy HTTP/2 header compression debug logs from the Supabase client transport
logging.getLogger("hpack").setLevel(logging.WARNING)

load_dotenv(".env")


class Assistant(Agent):
    """
    purpose: Voice assistant agent with senior-optimized persona and tool integrations
             for web search, reminders, contacts, and SMS messaging.
             Holds an optional ScreenCapture reference for SCREEN-4 frame injection.
    """

    def __init__(
        self,
        instructions: str,
        user_id: str,
        supabase: AsyncClient,
        engine: WorkflowEngine,
        ios_version: str,
        user_timezone: str = "America/New_York",
        screen_capture: "ScreenCapture | None" = None,
    ) -> None:
        """
        purpose: Initialize the Assistant with a pre-rendered system prompt and
                 the Supabase client + user_id needed for reminder CRUD tools,
                 plus the WorkflowEngine and iOS version for guided workflow support.
                 Accepts an optional ScreenCapture instance for SCREEN-4 frame injection.
        @param instructions: (str) The fully rendered system prompt from render_system_prompt().
        @param user_id: (str) UUID of the current user, used for all DB reminder operations.
        @param supabase: (AsyncClient) Authenticated Supabase async client.
        @param engine: (WorkflowEngine) Loaded workflow engine for task matching and step resolution.
        @param ios_version: (str) User's iOS major version string, e.g. "18" or "unknown".
        @param user_timezone: (str) IANA timezone from the user's profile, used for reminder storage.
        @param screen_capture: (ScreenCapture | None) Active screen capture instance, or None if
                               screen sharing has not started. Consumed by SCREEN-4.
        """
        super().__init__(instructions=instructions)
        self._user_id = user_id
        self._supabase = supabase
        self._engine = engine
        self._ios_version = ios_version
        self._user_timezone = user_timezone
        self._workflow_state: WorkflowState | None = None
        self._screen_capture = screen_capture
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
    async def create_reminder(
        self, context: RunContext, title: str, notes: str = "", due_date: str = ""
    ):
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

    @function_tool
    async def save_reminder(
        self,
        context: RunContext,
        reminder_type: str,
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
            reminder_type: Category of reminder: 'medication'|'appointment'|'exercise'|'wellness_checkin'|'custom'
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
                self._supabase,
                self._user_id,
                reminder_type,
                title,
                description,
                times,
                days,
                self._user_timezone,
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
        logger.info(
            f"Deleting reminder matching '{reminder_title}' for user {self._user_id}"
        )
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
            return (
                "I'm sorry, I had trouble cancelling that reminder. Please try again."
            )

    @function_tool
    async def start_workflow(self, context: RunContext, task_description: str) -> str:
        """
        purpose: Find and start a guided step-by-step workflow for an iPhone task.
                 Searches available workflow guides by task description, starts the
                 best match, and returns step context instructing the LLM to speak
                 the first step to the user and wait for their response.

        Args:
            task_description: Short description of what the user wants to do,
                               e.g. "block a contact", "adjust screen brightness"

        Returns:
            Step context string for the first step, or a message if no match found
        """
        workflow_id, workflow_title, has_steps = await self._engine.find_workflow(
            task_description
        )
        if not workflow_id:
            return (
                "I don't have a specific step-by-step guide for that yet. "
                "I can still try to help you — what would you like to do?"
            )
        if not has_steps:
            return (
                f"I know about '{workflow_title}' but that guide isn't ready yet. "
                "I can still try to help you manually."
            )
        self._workflow_state = await self._engine.resolve_workflow(
            workflow_id, self._ios_version, workflow_title
        )
        state = self._workflow_state
        if not state.step_ids:
            self._workflow_state = None
            return (
                f"I found a guide for '{workflow_title}' but it has no steps available. "
                "I can still try to help you manually."
            )
        step = state.step_map[state.step_ids[0]]
        total = len(state.step_ids)
        return format_step_context(step, 1, total, state.workflow_title)

    @function_tool
    async def confirm_step(self, context: RunContext) -> str:
        """
        purpose: Advance to the next step after the user explicitly confirms they
                 completed the current one. Returns step context instructing the LLM
                 to speak the next step, or a completion message if the workflow is done.
                 Do NOT call this based on silence — only call when user confirms.

        Returns:
            Step context for the next step, or a workflow-complete message
        """
        if not self._workflow_state:
            return "No workflow is currently active."
        state = self._workflow_state
        current_step = state.step_map[state.step_ids[state.current_index]]
        state.history.append(state.current_index)

        if (
            current_step.next_step is None
            or current_step.next_step not in state.step_map
        ):
            self._workflow_state = None
            return (
                f"Workflow complete. The user has finished '{state.workflow_title}'. "
                "Return to normal conversation."
            )

        next_index = state.step_ids.index(current_step.next_step)
        state.current_index = next_index
        next_step = state.step_map[current_step.next_step]
        total = len(state.step_ids)
        return format_step_context(
            next_step, next_index + 1, total, state.workflow_title
        )

    @function_tool
    async def go_back_step(self, context: RunContext) -> str:
        """
        purpose: Return to the previous step in the active workflow. Returns step
                 context instructing the LLM to re-deliver the previous step's
                 instruction and confirmation prompt.

        Returns:
            Step context for the previous step, or the first step if already there
        """
        if not self._workflow_state:
            return "No workflow is currently active."
        state = self._workflow_state
        total = len(state.step_ids)

        if not state.history:
            step = state.step_map[state.step_ids[0]]
            return (
                'Tell the user: "We\'re already at the first step." '
                "Then speak this step again: "
                + format_step_context(step, 1, total, state.workflow_title)
            )

        prev_index = state.history.pop()
        state.current_index = prev_index
        step = state.step_map[state.step_ids[prev_index]]
        return (
            'Tell the user: "No problem, let\'s go back." '
            "Then speak this step: "
            + format_step_context(step, prev_index + 1, total, state.workflow_title)
        )

    @function_tool
    async def exit_workflow(self, context: RunContext) -> str:
        """
        purpose: Exit the active workflow and return to normal conversation.

        Returns:
            Confirmation that the workflow was exited
        """
        if not self._workflow_state:
            return "No workflow is currently active."
        title = self._workflow_state.workflow_title
        self._workflow_state = None
        return f"Workflow '{title}' exited. Return to normal conversation."


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
             When the session was triggered by a notification tap, a reminder-specific
             initial greeting overrides the default welcome message.
    @param ctx: (JobContext) LiveKit job context providing room access and lifecycle hooks.
    """
    ctx.log_context_fields = {"room": ctx.room.name}

    # 1. Connect first — gives us access to participant metadata before building the prompt
    await ctx.connect()

    # 2. Resolve user_id and session context from participant metadata (or fallbacks)
    user_id = resolve_user_id(ctx.room)
    session_ctx = resolve_session_context(ctx.room)
    session_trigger = session_ctx.get("trigger", "app_open")
    session_reminder_id = session_ctx.get("reminder_id")
    session_adherence_log_id = session_ctx.get("adherence_log_id")

    # 3. Init Supabase, load context, create conversation row with session context
    supabase = await create_supabase_client()
    raw_context = await load_user_context(supabase, user_id)
    conversation_id = await create_conversation(
        supabase,
        user_id,
        trigger=session_trigger,
        reminder_id=session_reminder_id,
        adherence_log_id=session_adherence_log_id,
    )
    profile = raw_context.get("profile", {})
    user_name = profile.get("name", "")
    ios_version = profile.get("ios_version", "unknown")
    user_timezone = profile.get("timezone", "America/New_York")
    existing_profile_summary = profile.get("profile_summary", "")
    conv_logger = ConversationLogger(
        supabase, user_id, conversation_id, existing_profile_summary
    )

    # 4. Compute initial greeting override for notification-tap sessions
    #    When a reminder notification is tapped, greet the user with context rather than
    #    the generic welcome so the session feels like a purposeful check-in.
    name_part = f", {user_name}" if user_name else ""
    initial_greeting: str | None = None
    if session_trigger == "notification_tap" and session_reminder_id:
        reminders = raw_context.get("reminders", [])
        matched_reminder = next(
            (r for r in reminders if str(r.get("id", "")) == session_reminder_id),
            None,
        )
        if matched_reminder:
            r_title = matched_reminder.get("title", "your reminder")
            r_type = matched_reminder.get("type", "")
            if r_type == "medication":
                initial_greeting = (
                    f"Hi{name_part}! It's time for your {r_title}. Did you take it?"
                )
            else:
                initial_greeting = (
                    f"Hi{name_part}! I'm checking in about your {r_title}. "
                    "Is there anything you need help with?"
                )
            logger.info(f"Notification tap greeting: {initial_greeting!r}")

    # 5. Initialize workflow engine backed by Supabase (WF-4)
    engine = WorkflowEngine(supabase=supabase)
    logger.info("WorkflowEngine initialized with Supabase pgvector backend")

    # 5b. Screen share capture — receives frames from the iOS broadcast extension (SCREEN-3)
    screen_capture = ScreenCapture()

    # 6. Render system prompt with injected user context
    context_block = format_user_context(raw_context)
    rendered_prompt = render_system_prompt(context_block)
    logger.info(f"System prompt rendered for user_id={user_id}")

    # 7. Build session with senior-optimized voice UX parameters
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

    # 8. State variables for error recovery and reconnect detection
    consecutive_errors = 0
    last_disconnect_time: float | None = None
    last_topic: str = ""
    _greeted = False

    # 9. Real-time message logging — fires on every completed conversation turn
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
                    asyncio.create_task(conv_logger.log_message(item.role, text))  # noqa: RUF006

    # 10. STT garbage filter — silently discard noise before the LLM responds
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
            logger.info(f"Ignoring garbage STT input (user={user_id}): {text!r}")
            session.interrupt()

    # 11. Progressive error recovery — speak an escalating message on pipeline failures
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
        asyncio.create_task(  # noqa: RUF006
            session.say(_recovery_message(consecutive_errors, user_name))
        )

    # 12. Proactive greeting — speak once when session becomes idle and user isn't already talking
    @session.on("agent_state_changed")
    def _on_agent_state_changed(ev):
        """
        purpose: Deliver a proactive greeting the first time the agent reaches idle state,
                 but only if no conversation has occurred yet. If the user spoke before the
                 agent finished initializing, session.history will already contain messages
                 and the greeting is skipped to avoid overriding the response in progress.
                 When initial_greeting is set (notification-tap sessions), uses the reminder-
                 specific check-in message instead of the generic welcome.
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
                asyncio.create_task(session.say(greeting))  # noqa: RUF006

    # 13. Participant disconnect — record disconnect time and last topic for reconnect greeting
    def _on_participant_disconnected(participant):
        """
        purpose: Record the disconnect timestamp and last assistant message so the
                 agent can greet the user with context on a quick reconnect.
                 Also stops screen capture as a guard against missed track_unsubscribed
                 events on abrupt disconnects.
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
        logger.info(f"Participant {participant.identity} disconnected (user={user_id})")
        screen_capture.stop_capture()  # guard: stop capture if track event was missed
        asyncio.create_task(conv_logger.finalize(session.history))  # noqa: RUF006

    # 14. Participant reconnect — greet returning user within 10-minute window
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
            asyncio.create_task(session.say(greeting))  # noqa: RUF006
        last_disconnect_time = None

    # 13b. Track subscribed — start capturing frames from iOS screen share (SCREEN-3)
    def _on_track_subscribed(
        track: rtc.Track,
        publication: rtc.RemoteTrackPublication,
        participant: rtc.RemoteParticipant,
    ) -> None:
        """
        purpose: Start capturing frames when the participant publishes a video track
                 (screen share from the iOS broadcast extension).
        @param track: (rtc.Track) The subscribed track.
        @param publication: (rtc.RemoteTrackPublication) The track publication.
        @param participant: (rtc.RemoteParticipant) The publishing participant.
        """
        if track.kind == rtc.TrackKind.KIND_VIDEO:
            logger.info(f"Screen share track subscribed from {participant.identity}")
            screen_capture.start_capture(track)

    # 13c. Track unsubscribed — stop frame capture when screen share ends (SCREEN-3)
    def _on_track_unsubscribed(
        track: rtc.Track,
        publication: rtc.RemoteTrackPublication,
        participant: rtc.RemoteParticipant,
    ) -> None:
        """
        purpose: Stop frame capture when the screen share track is unpublished.
        @param track: (rtc.Track) The unsubscribed track.
        @param publication: (rtc.RemoteTrackPublication) The track publication.
        @param participant: (rtc.RemoteParticipant) The publishing participant.
        """
        if track.kind == rtc.TrackKind.KIND_VIDEO:
            logger.info(f"Screen share track unsubscribed from {participant.identity}")
            screen_capture.stop_capture()

    ctx.room.on("participant_disconnected", _on_participant_disconnected)
    ctx.room.on("participant_connected", _on_participant_connected)
    ctx.room.on("track_subscribed", _on_track_subscribed)
    ctx.room.on("track_unsubscribed", _on_track_unsubscribed)

    # 15. False interruption recovery — resume agent speech after background noise
    @session.on("agent_false_interruption")
    def _on_agent_false_interruption(ev: AgentFalseInterruptionEvent):
        """
        purpose: Resume agent speech after a false positive interruption (e.g. cough, TV noise).
        @param ev: (AgentFalseInterruptionEvent) Event with optional extra instructions.
        """
        logger.info("false positive interruption, resuming")
        session.generate_reply(instructions=ev.extra_instructions or NOT_GIVEN)

    # 16. Metrics collection
    usage_collector = metrics.UsageCollector()

    @session.on("metrics_collected")
    def _on_metrics_collected(ev: MetricsCollectedEvent):
        """
        purpose: Collect and log pipeline performance metrics on each turn.
        @param ev: (MetricsCollectedEvent) Event containing the metrics snapshot.
        """
        metrics.log_metrics(ev.metrics)
        usage_collector.collect(ev.metrics)

    # 17. Shutdown callbacks — safety fallback for process-kill scenarios and usage logging
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

    # 18. Start session — room is already connected, session.start() will not reconnect
    await session.start(
        agent=Assistant(
            instructions=rendered_prompt,
            user_id=user_id,
            supabase=supabase,
            engine=engine,
            ios_version=ios_version,
            user_timezone=user_timezone,
            screen_capture=screen_capture,
        ),
        room=ctx.room,
        room_input_options=RoomInputOptions(
            noise_cancellation=noise_cancellation.BVC(),
        ),
    )


if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint, prewarm_fnc=prewarm))
