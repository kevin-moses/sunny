# memory.py
# Purpose: Supabase integration for per-session household context and conversation logging.
# Handles: async Supabase client init, resolving the household and session trigger from
# LiveKit participant metadata (resolve_session), loading the household context via the
# get_agent_context RPC, real-time turn logging to conversation_turns, and a one-to-two
# sentence post-session summary written to the conversations row.
#
# Memory-care pivot (2026-10-25): sessions are scoped to a household instead of a user.
# The LLM-rewritten users.profile_summary paragraph was removed: it mixed caregiver facts
# with things the senior said and broke the memory-hygiene rule in notes/SPEC.md. Facts
# now live in agent_memory with a source and verified flag (written by later agent tools).
# Session context carries task_instance_id instead of reminder_id/adherence_log_id.
#
# Last modified: 2026-10-25

import json
import logging
import os
from datetime import datetime, timezone

from anthropic import AsyncAnthropic
from livekit import rtc
from livekit.agents.llm import ChatContext, ChatMessage
from supabase import AsyncClient, acreate_client

from config import SUMMARY_MAX_TOKENS, SUMMARY_MODEL

logger = logging.getLogger("agent.memory")


async def create_supabase_client() -> AsyncClient:
    """
    purpose: Initialize an async Supabase client from environment variables.
             Uses the service role key: the agent acts for the backend and passes the
             household explicitly to every query and RPC.
    @return: (AsyncClient) Authenticated Supabase async client.
    @raises: KeyError if SUPABASE_URL or SUPABASE_SECRET_KEY are not set.
    """
    url = os.environ["SUPABASE_URL"]
    key = os.environ["SUPABASE_SECRET_KEY"]
    return await acreate_client(url, key)


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


async def load_agent_context(client: AsyncClient, household_id: str | None) -> dict:
    """
    purpose: Load the household context for this session with the get_agent_context RPC:
             household profile and local time, today's task instances, as-needed meds,
             upcoming events, latest family message, life profile, sensitive topics,
             memory, and recent conversation summaries. Returns {} on any error.
    @param client: (AsyncClient) Supabase async client.
    @param household_id: (str | None) Household UUID; None returns {}.
    @return: (dict) Context dict as returned by get_agent_context, or {}.
    """
    if not household_id:
        return {}
    try:
        result = await client.rpc(
            "get_agent_context", {"p_household_id": household_id}
        ).execute()
        data = result.data
        if isinstance(data, dict):
            logger.info(f"Loaded agent context for household {household_id}")
            return data
        return {}
    except Exception as e:
        logger.warning(f"Failed to load agent context for {household_id}: {e}")
        return {}


async def create_conversation(
    client: AsyncClient,
    household_id: str | None,
    trigger: str = "talk",
    task_instance_id: str | None = None,
    device_id: str | None = None,
) -> str:
    """
    purpose: Insert a conversations row for this session and return its UUID.
    @param client: (AsyncClient) Supabase async client.
    @param household_id: (str | None) Household UUID; None skips logging.
    @param trigger: (str) What started the session: 'talk', 'scheduled_prompt',
                    'notification_tap', ...
    @param task_instance_id: (str | None) Task instance that triggered the session, if any.
    @param device_id: (str | None) Paired device the senior is talking through, if known.
    @return: (str) UUID of the new conversation, or "" when skipped or on failure.
    """
    if not household_id:
        return ""
    try:
        row: dict = {"household_id": household_id, "trigger": trigger}
        if task_instance_id:
            row["task_instance_id"] = task_instance_id
        if device_id:
            row["device_id"] = device_id
        result = await client.table("conversations").insert(row).execute()
        conversation_id = result.data[0]["id"]
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
             and, at session end, stores a short summary on the conversations row.
    """

    def __init__(self, client: AsyncClient, conversation_id: str) -> None:
        """
        purpose: Initialize the logger for one conversation.
        @param client: (AsyncClient) Supabase async client.
        @param conversation_id: (str) UUID of the conversations row, or "" to disable logging.
        """
        self._client = client
        self._conversation_id = conversation_id
        self._finalized: bool = False

    async def log_message(self, role: str, content: str) -> None:
        """
        purpose: Insert one conversation turn. Warns on error rather than raising so the
                 voice pipeline is never disrupted.
        @param role: (str) "user" or "assistant".
        @param content: (str) Text of the turn.
        """
        if not self._conversation_id:
            return
        try:
            await (
                self._client.table("conversation_turns")
                .insert(
                    {
                        "conversation_id": self._conversation_id,
                        "role": role,
                        "content": content,
                    }
                )
                .execute()
            )
        except Exception as e:
            logger.warning(
                f"Failed to log {role} turn (conversation={self._conversation_id}): {e}"
            )

    async def finalize(self, chat_history: ChatContext) -> None:
        """
        purpose: Called when the session ends. Sets ended_at, generates a short summary
                 of the transcript, and stores it on the conversations row. Idempotent:
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

        update: dict = {"ended_at": datetime.now(timezone.utc).isoformat()}
        if transcript_lines:
            summary = await self._generate_summary("\n".join(transcript_lines))
            if summary:
                update["summary"] = summary
        else:
            logger.info("No transcript content to summarize")

        try:
            await (
                self._client.table("conversations")
                .update(update)
                .eq("id", self._conversation_id)
                .execute()
            )
            logger.info(f"Session finalized for conversation {self._conversation_id}")
        except Exception as e:
            logger.warning(
                f"Failed to finalize conversation {self._conversation_id}: {e}"
            )

    async def _generate_summary(self, transcript: str) -> str:
        """
        purpose: Ask Claude for a short factual summary of the session, stored on the
                 conversations row and shown to the agent in later sessions. Uses
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
