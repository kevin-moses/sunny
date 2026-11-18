import asyncio
import json
import logging
import os
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

from anthropic import AsyncAnthropic
from anthropic.types import TextBlock
from livekit import rtc
from livekit.agents.llm import ChatContext, ChatItem, ChatMessage, FunctionCall

from config import (
    SUMMARY_ATTEMPTS,
    SUMMARY_MAX_TOKENS,
    SUMMARY_MODEL,
    SUMMARY_TIMEOUT_S,
)
from convex_client import (
    ConvexArgs,
    ConvexMutation,
    ConvexQuery,
    mutation_as,
    query_as,
)
from convex_types import AGENT_CONTEXT, CONVERSATION_ID, AgentContext, QuestionRow

logger = logging.getLogger("agent.memory")

_OUTCOMES = {"answered", "routed", "unsure"}
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
    summary: str | None = None
    questions: list[QuestionRow] = field(default_factory=list)


def build_transcript(items: list[ChatItem]) -> tuple[str, dict[int, float]]:
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


@dataclass(frozen=True)
class SessionInfo:
    household_id: str | None
    trigger: str
    task_instance_id: str | None
    device_id: str | None


def resolve_session(room: rtc.Room) -> SessionInfo:
    data: dict[str, str | None] = {}
    for participant in room.remote_participants.values():
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
    return SessionInfo(
        household_id=household_id,
        trigger=data.get("trigger") or "talk",
        task_instance_id=data.get("task_instance_id"),
        device_id=data.get("device_id"),
    )


async def load_agent_context(
    client: ConvexQuery, household_id: str | None
) -> AgentContext | None:
    if not household_id:
        return None
    try:
        context = await query_as(
            client, "agent:getContext", {"householdId": household_id}, AGENT_CONTEXT
        )
    except Exception as e:
        logger.error(f"Failed to load agent context for {household_id}: {e}")
        return None
    logger.info(f"Loaded agent context for household {household_id}")
    return context


async def create_conversation(
    client: ConvexMutation,
    household_id: str | None,
    trigger: str = "talk",
    task_instance_id: str | None = None,
    device_id: str | None = None,
) -> str:
    if not household_id:
        return ""
    try:
        conversation_id = await mutation_as(
            client,
            "agent:startConversation",
            {
                "householdId": household_id,
                "deviceId": device_id or None,
                "trigger": trigger,
                "taskInstanceId": task_instance_id or None,
            },
            CONVERSATION_ID,
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
    def __init__(
        self,
        client: ConvexMutation,
        conversation_id: str,
        known_topics: list[str] | None = None,
    ) -> None:
        self._client = client
        self._conversation_id = conversation_id
        self._known_topics = known_topics or []
        self._pending: set[asyncio.Task[None]] = set()
        self._finalize_task: asyncio.Task[None] | None = None

    def track_log_message(self, role: str, content: str) -> None:
        task = asyncio.ensure_future(self.log_message(role, content))
        self._pending.add(task)
        task.add_done_callback(self._pending.discard)

    async def wait_idle(self) -> None:
        while self._pending:
            await asyncio.gather(*list(self._pending), return_exceptions=True)

    async def log_message(self, role: str, content: str) -> None:
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
        self.start_finalize(chat_history)
        if self._finalize_task is not None:
            await asyncio.shield(self._finalize_task)

    def start_finalize(self, chat_history: ChatContext) -> None:
        if self._conversation_id and self._finalize_task is None:
            self._finalize_task = asyncio.ensure_future(
                self._run_finalize(chat_history)
            )

    async def _run_finalize(self, chat_history: ChatContext) -> None:
        await self.wait_idle()
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

    async def _mutate(self, path: str, args: ConvexArgs) -> None:
        try:
            await self._client.mutation(
                path, {"conversationId": self._conversation_id, **args}
            )
        except Exception as e:
            logger.warning(f"{path} failed for {self._conversation_id}: {e}")

    async def _extract_record(
        self, transcript: str, turn_times: dict[int, float]
    ) -> SessionRecord:
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
                text = "".join(
                    block.text
                    for block in response.content
                    if isinstance(block, TextBlock)
                )
                return parse_session_record(text, turn_times)
            except Exception as e:
                logger.warning(f"Session record attempt {attempt} failed: {e}")
        return SessionRecord()


async def shutdown_conversation(
    close_client: Callable[[], Awaitable[None]],
    conv_logger: ConversationLogger | None,
    chat_history: ChatContext | None,
) -> None:
    try:
        if conv_logger is not None:
            if chat_history is not None:
                await conv_logger.finalize(chat_history)
            await conv_logger.wait_idle()
    finally:
        await close_client()
