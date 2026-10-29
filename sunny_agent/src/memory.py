# memory.py
# Purpose: Convex integration for per-session household context and conversation logging.
# Handles: resolving the household and session trigger from
# LiveKit participant metadata (resolve_session), loading the household context via the
# agent:getContext query, real-time turn logging (agent:logTurn), and a one-to-two
# sentence post-session summary stored when the conversation is finished
# (agent:finishConversation, which also sets the end time).
#
# Memory-care pivot (2026-10-25): sessions are scoped to a household instead of a user.
# The LLM-rewritten users.profile_summary paragraph was removed: it mixed caregiver facts
# with things the senior said and broke the memory-hygiene rule in notes/SPEC.md. Facts
# now live in agent_memory with a source and verified flag (written by later agent tools).
# Session context carries task_instance_id instead of reminder_id/adherence_log_id.
# Convex migration (2026-10-29): replaced supabase-py with ConvexClient (convex_client.py).
#
# Last modified: 2026-10-29

import json
import logging
import os

from anthropic import AsyncAnthropic
from livekit import rtc
from livekit.agents.llm import ChatContext, ChatMessage

from config import SUMMARY_MAX_TOKENS, SUMMARY_MODEL
from convex_client import ConvexClient

logger = logging.getLogger("agent.memory")


def resolve_session(room: rtc.Room) -> dict:
    """
    purpose: Read who this session is for and how it started from the first remote
             participant's metadata. The livekit-token Edge Function writes it after
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

    def __init__(self, client: ConvexClient, conversation_id: str) -> None:
        """
        purpose: Initialize the logger for one conversation.
        @param client: (ConvexClient) Convex client.
        @param conversation_id: (str) Id of the conversation, or "" to disable logging.
        """
        self._client = client
        self._conversation_id = conversation_id
        self._finalized: bool = False

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
        purpose: Called when the session ends. Generates a short summary of the transcript
                 and finishes the conversation (which sets its end time). Idempotent:
                 the disconnect handler and the shutdown callback may both call it.
        @param chat_history: (ChatContext) AgentSession.history; only user/assistant
                             ChatMessage items are used.
        """
        if self._finalized or not self._conversation_id:
            return
        self._finalized = True

        transcript_lines = [
            f"{item.role.upper()}: {item.text_content}"
            for item in chat_history.items
            if isinstance(item, ChatMessage)
            and item.role in ("user", "assistant")
            and item.text_content
        ]

        summary: str | None = None
        if transcript_lines:
            summary = await self._generate_summary("\n".join(transcript_lines)) or None
        else:
            logger.info("No transcript content to summarize")

        try:
            await self._client.mutation(
                "agent:finishConversation",
                {"conversationId": self._conversation_id, "summary": summary},
            )
            logger.info(f"Session finalized for conversation {self._conversation_id}")
        except Exception as e:
            logger.warning(
                f"Failed to finalize conversation {self._conversation_id}: {e}"
            )

    async def _generate_summary(self, transcript: str) -> str:
        """
        purpose: Ask Claude for a short factual summary of the session, stored on the
                 conversation and shown to the agent in later sessions. Uses
                 AsyncAnthropic so finalization never blocks the event loop.
        @param transcript: (str) Newline-joined "ROLE: content" lines from the session.
        @return: (str) One or two plain sentences, or "" on failure.
        """
        prompt = (
            "Summarize this conversation between a voice assistant and an older adult "
            "with memory difficulties in 1-2 plain sentences: what was asked and what "
            "was answered or done. Reply with the summary only.\n\n"
            f"Conversation transcript:\n{transcript}"
        )
        try:
            response = await AsyncAnthropic().messages.create(
                model=SUMMARY_MODEL,
                max_tokens=SUMMARY_MAX_TOKENS,
                messages=[{"role": "user", "content": prompt}],
            )
            return response.content[0].text.strip()
        except Exception as e:
            logger.warning(f"Failed to generate session summary: {e}")
            return ""
