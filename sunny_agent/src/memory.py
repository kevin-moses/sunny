# memory.py
# Purpose: Convex integration for per-session household context and conversation logging.
# Handles: resolving the household and session trigger from
# LiveKit participant metadata (resolve_session), loading the household context via the
# agent:getContext query, real-time turn logging (agent:logTurn), and a one-to-two
# sentence post-session summary stored when the conversation is finished
# (agent:finishConversation, which also sets the end time).
#
# Sessions are scoped to a household. Facts the agent knows come from getContext (verified
# caregiver facts and unverified things the senior said, each labelled); no LLM-rewritten
# profile paragraph is kept, per the memory-hygiene rule in notes/SPEC.md.
#
# Shutdown: ConversationLogger tracks its pending logTurn tasks and the finalize task. finalize
# waits for pending turns, and a second call awaits the first run; wait_idle drains outstanding
# writes, and shutdown_conversation finalizes, drains and only then closes the Convex client
# (in a finally), so the end-of-session writes never hit a closed client.
#
# Summary and question log: finalize first ends the conversation (agent:finishConversation sets
# endedAt), so a slow or failing model never loses the record. It then makes one model call
# (20-second timeout per attempt, one retry) that returns both the summary and the senior's
# questions (question, short topic, outcome answered / routed / unsure, tools used). The
# summary is written with a second finishConversation, and the questions with
# agent:logQuestions (idempotent per conversation) for the digest's repeat and unanswered
# counts. Doing this after the call adds no spoken latency. The extractor's transcript marks
# each user turn [T1], [T2], ... and each tool call "TOOL: name"; a question's askedAt is its
# user turn's time. Last week's topics (getContext recentQuestionTopics) are offered so a
# repeated question reuses its topic. A reply that is not JSON becomes a plain summary.
#
# Last modified: 2026-11-09

import asyncio
import json
import logging
import os
from dataclasses import dataclass, field

from anthropic import AsyncAnthropic
from livekit import rtc
from livekit.agents.llm import ChatContext, ChatMessage, FunctionCall

from config import (
    SUMMARY_ATTEMPTS,
    SUMMARY_MAX_TOKENS,
    SUMMARY_MODEL,
    SUMMARY_TIMEOUT_S,
)
from convex_client import ConvexClient

logger = logging.getLogger("agent.memory")

_OUTCOMES = {"answered", "routed", "unsure"}
# Longest plain-text summary kept when the extractor's reply is not JSON.
_MAX_PLAIN_SUMMARY = 500

_RECORD_PROMPT = """You review one voice conversation between Sunny (a voice assistant on a \
home display) and an older adult with memory difficulties. Reply with JSON only, no other \
text, in exactly this shape:
{{"summary": "...", "questions": [{{"turn": 1, "question": "...", "topic": "...", \
"outcome": "answered", "tools": ["list_today"]}}]}}

summary: 1-2 plain sentences: what was asked and what was answered or done.
questions: one entry per question or request the person made. Their turns are marked [T1], \
[T2], and so on; "turn" is that number. Skip greetings, thanks, and confirmations such as \
"done", "yes" or "not yet". Repeated questions get one entry each.
- question: the person's words, lightly cleaned up.
- topic: 2 to 4 lowercase words naming what it is about, such as "sarah visit time", \
"weather", "morning pills". If it is about the same thing as one of these earlier topics, \
reuse that topic exactly: {topics}
- outcome: "answered" if Sunny answered it or did it; "routed" if Sunny passed it to family \
(flag_caregiver or send_family_message) or told them to ask family; "unsure" if Sunny said it \
did not know or could not do it.
- tools: the TOOL names Sunny used for it, in order; [] when none.

Transcript:
{transcript}"""


@dataclass
class SessionRecord:
    """
    purpose: What finalize writes after a session: the summary and the question rows.
    """

    summary: str | None = None
    questions: list[dict] = field(default_factory=list)


def build_transcript(items: list) -> tuple[str, dict[int, float]]:
    """
    purpose: Render session history for the extractor: user turns numbered [T1], [T2], ...,
             assistant turns, and tool calls as "TOOL: name".
    @param items: (list) ChatContext.items (ChatMessage, FunctionCall, FunctionCallOutput).
    @return: (tuple[str, dict[int, float]]) The transcript text (empty when nobody spoke) and
             each user turn's created_at in seconds, by turn number.
    """
    lines: list[str] = []
    turn_times: dict[int, float] = {}
    for item in items:
        if isinstance(item, FunctionCall):
            lines.append(f"TOOL: {item.name}")
        elif (
            isinstance(item, ChatMessage)
            and item.role in ("user", "assistant")
            and item.text_content
        ):
            if item.role == "user":
                turn = len(turn_times) + 1
                turn_times[turn] = item.created_at
                lines.append(f"[T{turn}] USER: {item.text_content}")
            else:
                lines.append(f"ASSISTANT: {item.text_content}")
    if all(line.startswith("TOOL:") for line in lines):
        return "", {}
    return "\n".join(lines), turn_times


def parse_session_record(text: str, turn_times: dict[int, float]) -> SessionRecord:
    """
    purpose: Parse the extractor's JSON reply into a SessionRecord, dropping malformed
             question entries.
    @param text: (str) The model's reply; a surrounding code fence is tolerated.
    @param turn_times: (dict[int, float]) User turn times in seconds, by turn number.
    @return: (SessionRecord) The summary and agent:logQuestions-shaped question dicts
             (askedAt in epoch ms when the turn is known, else None). A reply that is not a
             JSON object becomes a plain summary (one line, at most 500 characters) with no
             questions, unless it looks like broken JSON, which gives an empty record.
    """
    body = text.strip()
    if body.startswith("```"):
        body = body.strip("`").removeprefix("json").strip()
    try:
        data = json.loads(body)
    except ValueError:
        logger.warning("Session record was not valid JSON")
        data = None
    if not isinstance(data, dict):
        plain = " ".join(body.split())[:_MAX_PLAIN_SUMMARY]
        if not plain or plain[0] in "{[":
            return SessionRecord()
        return SessionRecord(summary=plain)
    summary = data.get("summary")
    record = SessionRecord(
        summary=summary.strip()
        if isinstance(summary, str) and summary.strip()
        else None
    )
    for entry in data.get("questions") or []:
        if not isinstance(entry, dict):
            continue
        question, topic = entry.get("question"), entry.get("topic")
        outcome = entry.get("outcome")
        if not isinstance(question, str) or not isinstance(topic, str):
            continue
        if outcome not in _OUTCOMES:
            continue
        tools = entry.get("tools")
        turn = entry.get("turn")
        asked = turn_times.get(turn) if isinstance(turn, int) else None
        record.questions.append(
            {
                "question": question,
                "topic": topic,
                "outcome": outcome,
                "toolsUsed": [t for t in tools if isinstance(t, str)]
                if isinstance(tools, list)
                else [],
                "askedAt": round(asked * 1000) if asked else None,
            }
        )
    return record


def resolve_session(room: rtc.Room) -> dict:
    """
    purpose: Read who this session is for and how it started from the first remote
             participant's metadata. The voice.livekitToken Convex action writes it after
             verifying the caller's paired device. When no household is present, falls
             back to the DEV_HOUSEHOLD_ID environment variable for local testing with a
             sandbox token.
    @param room: (livekit.rtc.Room) The connected LiveKit room.
    @return: (dict) Keys: household_id (str | None; None means the agent answers general
             questions but cannot read or log household state), trigger (str, default
             'talk'), task_instance_id (str | None), device_id (str | None).
    """
    data: dict = {}
    for _identity, participant in room.remote_participants.items():
        if participant.metadata:
            try:
                parsed = json.loads(participant.metadata)
            except json.JSONDecodeError:
                continue
            if isinstance(parsed, dict):
                data = parsed
                break

    household_id = (
        data.get("household_id") or os.environ.get("DEV_HOUSEHOLD_ID") or None
    )
    if not data.get("household_id"):
        logger.warning(
            f"No household in participant metadata; DEV_HOUSEHOLD_ID={household_id}"
        )
    return {
        "household_id": household_id,
        "trigger": data.get("trigger") or "talk",
        "task_instance_id": data.get("task_instance_id"),
        "device_id": data.get("device_id"),
    }


async def load_agent_context(client: ConvexClient, household_id: str | None) -> dict:
    """
    purpose: Load the household context for this session with the agent:getContext query:
             household profile and local time, today's task instances, as-needed meds,
             upcoming events, latest family message, life profile, sensitive topics,
             memory, and recent conversation summaries. Returns {} on any error.
    @param client: (ConvexClient) Convex client.
    @param household_id: (str | None) Household id; None returns {}.
    @return: (dict) Context dict as returned by agent:getContext (camelCase keys, epoch-ms
             instants), or {}.
    """
    if not household_id:
        return {}
    try:
        data = await client.query("agent:getContext", {"householdId": household_id})
        if isinstance(data, dict):
            logger.info(f"Loaded agent context for household {household_id}")
            return data
        return {}
    except Exception as e:
        logger.warning(f"Failed to load agent context for {household_id}: {e}")
        return {}


async def create_conversation(
    client: ConvexClient,
    household_id: str | None,
    trigger: str = "talk",
    task_instance_id: str | None = None,
    device_id: str | None = None,
) -> str:
    """
    purpose: Start a conversation record for this session and return its id.
    @param client: (ConvexClient) Convex client.
    @param household_id: (str | None) Household id; None skips logging.
    @param trigger: (str) What started the session: 'talk', 'scheduled_prompt',
                    'notification_tap', ...
    @param task_instance_id: (str | None) Task instance that triggered the session, if any.
    @param device_id: (str | None) Paired device the senior is talking through, if known.
    @return: (str) Id of the new conversation, or "" when skipped or on failure.
    """
    if not household_id:
        return ""
    try:
        conversation_id = await client.mutation(
            "agent:startConversation",
            {
                "householdId": household_id,
                "deviceId": device_id or None,
                "trigger": trigger,
                "taskInstanceId": task_instance_id or None,
            },
        )
        logger.info(
            f"Created conversation {conversation_id} for household {household_id} "
            f"(trigger={trigger})"
        )
        return conversation_id
    except Exception as e:
        logger.warning(f"Failed to create conversation: {e}")
        return ""


class ConversationLogger:
    """
    purpose: Owns a single session's conversation record: logs each turn as it happens
             and, at session end, stores a short summary with the conversation.
    """

    def __init__(
        self,
        client: ConvexClient,
        conversation_id: str,
        known_topics: list[str] | None = None,
    ) -> None:
        """
        purpose: Initialize the logger for one conversation.
        @param client: (ConvexClient) Convex client.
        @param conversation_id: (str) Id of the conversation, or "" to disable logging.
        @param known_topics: (list[str] | None) Question topics of the last week, offered to
                             the extractor so a repeated question reuses its topic.
        """
        self._client = client
        self._conversation_id = conversation_id
        self._known_topics = known_topics or []
        self._pending: set[asyncio.Task[None]] = set()
        self._finalize_task: asyncio.Task[None] | None = None

    def track_log_message(self, role: str, content: str) -> None:
        """
        purpose: Start logging one turn in the background and remember the task, so
                 wait_idle and finalize can wait for it before the client is closed.
        @param role: (str) "user" or "assistant".
        @param content: (str) Text of the turn.
        """
        task = asyncio.ensure_future(self.log_message(role, content))
        self._pending.add(task)
        task.add_done_callback(self._pending.discard)

    async def wait_idle(self) -> None:
        """
        purpose: Wait until every tracked turn write has finished (including ones started
                 while waiting). Never raises: log_message already swallows errors.
        """
        while self._pending:
            await asyncio.gather(*list(self._pending), return_exceptions=True)

    async def log_message(self, role: str, content: str) -> None:
        """
        purpose: Log one conversation turn. Warns on error rather than raising so the
                 voice pipeline is never disrupted.
        @param role: (str) "user" or "assistant".
        @param content: (str) Text of the turn.
        """
        if not self._conversation_id:
            return
        try:
            await self._client.mutation(
                "agent:logTurn",
                {
                    "conversationId": self._conversation_id,
                    "role": role,
                    "content": content,
                },
            )
        except Exception as e:
            logger.warning(
                f"Failed to log {role} turn (conversation={self._conversation_id}): {e}"
            )

    async def finalize(self, chat_history: ChatContext) -> None:
        """
        purpose: Called when the session ends. Waits for pending turn writes, extracts a
                 short summary and the senior's questions from the transcript, finishes the
                 conversation (which sets its end time) and logs the questions. Idempotent: the disconnect handler and the shutdown
                 callback may both call it, and the second call awaits the first run
                 instead of returning early, so a caller can rely on the conversation
                 being finished once finalize returns.
        @param chat_history: (ChatContext) AgentSession.history; only user/assistant
                             ChatMessage items are used.
        """
        if not self._conversation_id:
            return
        if self._finalize_task is None:
            self._finalize_task = asyncio.ensure_future(
                self._run_finalize(chat_history)
            )
        await asyncio.shield(self._finalize_task)

    async def _run_finalize(self, chat_history: ChatContext) -> None:
        """
        purpose: Do the work of finalize once: drain turn writes, extract the summary and
                 questions, finish the conversation, then log the questions.
        @param chat_history: (ChatContext) AgentSession.history.
        """
        await self.wait_idle()
        # End the conversation first, so a slow or failing model never loses the record.
        await self._mutate("agent:finishConversation", {"summary": None})

        transcript, turn_times = build_transcript(chat_history.items)
        if not transcript:
            logger.info("No transcript content to summarize")
            return
        record = await self._extract_record(transcript, turn_times)
        if record.summary:
            await self._mutate("agent:finishConversation", {"summary": record.summary})
        if record.questions:
            await self._mutate("agent:logQuestions", {"questions": record.questions})
        logger.info(f"Session finalized for conversation {self._conversation_id}")

    async def _mutate(self, path: str, args: dict) -> None:
        """
        purpose: Run one end-of-session mutation for this conversation, logging (never
                 raising) a failure so the next step still runs.
        @param path: (str) Function path.
        @param args: (dict) Arguments besides conversationId.
        """
        try:
            await self._client.mutation(
                path, {"conversationId": self._conversation_id, **args}
            )
        except Exception as e:
            logger.warning(f"{path} failed for {self._conversation_id}: {e}")

    async def _extract_record(
        self, transcript: str, turn_times: dict[int, float]
    ) -> SessionRecord:
        """
        purpose: Ask Claude for the session summary (stored on the conversation and shown to
                 the agent in later sessions) and the senior's questions (for the digest), in
                 one call, with a SUMMARY_TIMEOUT_S timeout per attempt and SUMMARY_ATTEMPTS
                 attempts. Uses AsyncAnthropic so finalization never blocks the event loop.
        @param transcript: (str) Output of build_transcript.
        @param turn_times: (dict[int, float]) User turn times in seconds, by turn number.
        @return: (SessionRecord) The parsed record; empty when every attempt failed.
        """
        prompt = _RECORD_PROMPT.format(
            topics=", ".join(self._known_topics) or "(none yet)",
            transcript=transcript,
        )
        client = AsyncAnthropic(timeout=SUMMARY_TIMEOUT_S, max_retries=0)
        for attempt in range(1, SUMMARY_ATTEMPTS + 1):
            try:
                response = await asyncio.wait_for(
                    client.messages.create(
                        model=SUMMARY_MODEL,
                        max_tokens=SUMMARY_MAX_TOKENS,
                        messages=[{"role": "user", "content": prompt}],
                    ),
                    timeout=SUMMARY_TIMEOUT_S,
                )
                return parse_session_record(response.content[0].text, turn_times)
            except Exception as e:
                logger.warning(f"Session record attempt {attempt} failed: {e}")
        return SessionRecord()


async def shutdown_conversation(
    client: ConvexClient,
    conv_logger: ConversationLogger | None,
    chat_history: ChatContext | None,
) -> None:
    """
    purpose: End-of-session cleanup in the only safe order: finalize the conversation
             (awaiting a finalize the disconnect handler already started), drain any
             remaining turn writes, then close the Convex client, even if a step fails.
    @param client: (ConvexClient) Client to close last.
    @param conv_logger: (ConversationLogger | None) The session's logger, or None when the
                        session failed before it was created.
    @param chat_history: (ChatContext | None) Session history, or None when the session
                         never started (then no summary is written).
    """
    try:
        if conv_logger is not None:
            if chat_history is not None:
                await conv_logger.finalize(chat_history)
            await conv_logger.wait_idle()
    finally:
        await client.aclose()
