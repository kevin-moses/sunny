# memory.py
# Purpose: Supabase integration for per-session user context loading and conversation logging.
# Handles: async Supabase client init, user context RPC calls, real-time message logging,
# post-session summarization via Claude, and upsert of extracted facts into user_facts.
#
# Last modified: 2026-02-22

import json
import logging
import os
from datetime import datetime, timezone

import anthropic
from livekit.agents.llm import ChatMessage
from supabase import AsyncClient, acreate_client

from config import FALLBACK_USER_ID, SUMMARY_MAX_TOKENS, SUMMARY_MODEL

logger = logging.getLogger("agent.memory")


async def create_supabase_client() -> AsyncClient:
    """
    purpose: Initialize an async Supabase client from environment variables.
    @return: (AsyncClient) Authenticated Supabase async client.
    @raises: KeyError if SUPABASE_URL or SUPABASE_SECRET_KEY are not set.
    """
    url = os.environ["SUPABASE_URL"]
    key = os.environ["SUPABASE_SECRET_KEY"]
    return await acreate_client(url, key)


def resolve_user_id(room) -> str:
    """
    purpose: Extract the user_id from the first remote participant's metadata JSON.
             Falls back to FALLBACK_USER_ID if no valid metadata is found.
    @param room: (livekit.rtc.Room) The connected LiveKit room.
    @return: (str) UUID string for the user.
    """
    for identity, participant in room.remote_participants.items():
        if participant.metadata:
            try:
                data = json.loads(participant.metadata)
                user_id = data.get("user_id")
                if user_id:
                    logger.info(f"Resolved user_id={user_id} from participant {identity}")
                    return user_id
            except (json.JSONDecodeError, KeyError):
                pass
    logger.warning("No user_id found in participant metadata, using fallback user_id")
    return FALLBACK_USER_ID


async def load_user_context(client: AsyncClient, user_id: str) -> dict:
    """
    purpose: Call the get_user_context RPC to load profile, facts, summaries,
             and reminders for a user. Returns {} on any error.
    @param client: (AsyncClient) Supabase async client.
    @param user_id: (str) UUID of the user to load context for.
    @return: (dict) Context dict with keys: profile, facts, summaries, reminders.
    """
    try:
        result = await client.rpc("get_user_context", {"p_user_id": user_id}).execute()
        data = result.data
        if data:
            name = data.get("profile", {}).get("name", user_id)
            logger.info(f"Loaded user context for {name}")
            return data
        return {}
    except Exception as e:
        logger.warning(f"Failed to load user context for {user_id}: {e}")
        return {}


async def create_conversation(client: AsyncClient, user_id: str) -> str:
    """
    purpose: Insert a new row in the conversations table and return its UUID.
    @param client: (AsyncClient) Supabase async client.
    @param user_id: (str) UUID of the user this conversation belongs to.
    @return: (str) UUID of the newly created conversation, or "" on failure.
    """
    try:
        result = await client.table("conversations").insert({
            "user_id": user_id,
            "status": "active",
        }).execute()
        conversation_id = result.data[0]["id"]
        logger.info(f"Created conversation {conversation_id} for user {user_id}")
        return conversation_id
    except Exception as e:
        logger.warning(f"Failed to create conversation: {e}")
        return ""


class ConversationLogger:
    """
    purpose: Owns a single session's database record, handling real-time message
             logging and post-session finalization (summary generation + fact upsert).
    """

    def __init__(self, client: AsyncClient, user_id: str, conversation_id: str) -> None:
        """
        purpose: Initialize the logger with references to the Supabase client and
                 the IDs needed for all DB operations in this session.
        @param client: (AsyncClient) Supabase async client.
        @param user_id: (str) UUID of the user.
        @param conversation_id: (str) UUID of the conversation row for this session.
        """
        self._client = client
        self._user_id = user_id
        self._conversation_id = conversation_id

    async def log_message(self, role: str, content: str) -> None:
        """
        purpose: Insert a single conversation turn into the messages table.
                 Silently warns on error (with conversation_id context) to avoid
                 disrupting the voice pipeline.
        @param role: (str) One of "user" or "assistant".
        @param content: (str) The text content of the message.
        """
        if not self._conversation_id:
            return
        try:
            await self._client.table("messages").insert({
                "conversation_id": self._conversation_id,
                "role": role,
                "content": content,
            }).execute()
        except Exception as e:
            logger.warning(f"Failed to log {role} message (conversation={self._conversation_id}): {e}")

    async def finalize(self, chat_history) -> None:
        """
        purpose: Called at session shutdown. Marks the conversation completed,
                 generates a Claude summary of the transcript, and stores results.
        @param chat_history: (ChatContext) The session's full chat history from
                             AgentSession.history. Items filtered to user/assistant
                             ChatMessage instances only.
        """
        if not self._conversation_id:
            return

        # Mark conversation ended
        try:
            await self._client.table("conversations").update({
                "ended_at": datetime.now(timezone.utc).isoformat(),
                "status": "completed",
            }).eq("id", self._conversation_id).execute()
        except Exception as e:
            logger.warning(f"Failed to mark conversation as completed: {e}")
            return

        # Build transcript from chat history
        transcript_lines = []
        for item in chat_history.items:
            if isinstance(item, ChatMessage) and item.role in ("user", "assistant"):
                text = item.text_content
                if text:
                    transcript_lines.append(f"{item.role.upper()}: {text}")

        if not transcript_lines:
            logger.info("No transcript content to summarize")
            return

        logger.info(f"Generating summary for {len(transcript_lines)} transcript turns")
        transcript = "\n".join(transcript_lines)
        result = await self._generate_summary(transcript)

        summary = result.get("summary", "")
        facts = result.get("facts", [])
        concerns = result.get("concerns", [])

        logger.info(f"Summary: {summary}")
        if facts:
            for f in facts:
                logger.info(f"  Extracted fact — {f.get('category')}/{f.get('key')}: {f.get('value')}")
        else:
            logger.info("  No facts extracted")
        if concerns:
            for c in concerns:
                logger.warning(f"  Flagged concern: {c}")

        await self._store_summary(summary, facts, concerns)
        logger.info(f"Session finalized for conversation {self._conversation_id}")

    async def _generate_summary(self, transcript: str) -> dict:
        """
        purpose: Call Claude directly (sync Anthropic SDK) to produce a structured
                 summary of the session transcript. Returns a safe fallback on parse failure.
        @param transcript: (str) Newline-joined "ROLE: content" lines from the session.
        @return: (dict) Keys: summary (str), facts (list of dicts), concerns (list of str).
        """
        prompt = (
            "You are analyzing a conversation between a voice assistant (Sunny) and an elderly user.\n\n"
            f"Conversation transcript:\n{transcript}\n\n"
            "Generate a JSON response with exactly these keys:\n"
            '1. "summary": A 2-3 sentence summary of what was discussed.\n'
            '2. "facts": A list of facts learned about the user. Each fact is an object with '
            '"category" (one of: medication, health, preference, personal, device), "key", and "value".\n'
            '3. "concerns": A list of any health or safety concerns mentioned (plain strings). '
            "Empty list if none.\n\n"
            "Respond with valid JSON only, no markdown or other text."
        )
        try:
            logger.info(f"Calling {SUMMARY_MODEL} to summarize transcript ({len(transcript.splitlines())} lines)")
            sdk_client = anthropic.Anthropic()
            response = sdk_client.messages.create(
                model=SUMMARY_MODEL,
                max_tokens=SUMMARY_MAX_TOKENS,
                messages=[{"role": "user", "content": prompt}],
            )
            text = response.content[0].text.strip()
            # Strip markdown code fences if the model adds them
            if text.startswith("```"):
                parts = text.split("```")
                text = parts[1].lstrip("json").strip() if len(parts) > 1 else text
            parsed = json.loads(text)
            return {
                "summary": parsed.get("summary", ""),
                "facts": parsed.get("facts", []),
                "concerns": parsed.get("concerns", []),
            }
        except Exception as e:
            logger.warning(f"Failed to generate session summary: {e}")
            return {"summary": "", "facts": [], "concerns": []}

    async def _store_summary(self, summary: str, facts: list, concerns: list) -> None:
        """
        purpose: Insert the generated summary into session_summaries and upsert
                 each extracted fact into user_facts via RPC.
        @param summary: (str) Human-readable session summary.
        @param facts: (list) List of dicts with keys: category, key, value.
        @param concerns: (list) List of plain-string health/safety concern descriptions.
        """
        try:
            await self._client.table("session_summaries").insert({
                "conversation_id": self._conversation_id,
                "summary": summary,
                "extracted_facts": facts,
                "flagged_concerns": concerns,
            }).execute()
        except Exception as e:
            logger.warning(f"Failed to store session summary (conversation={self._conversation_id}): {e}")
            return

        for fact in facts:
            try:
                await self._client.rpc("upsert_user_fact", {
                    "p_user_id": self._user_id,
                    "p_category": fact.get("category"),
                    "p_key": fact.get("key"),
                    "p_value": fact.get("value"),
                    "p_conversation_id": self._conversation_id,
                }).execute()
            except Exception as e:
                logger.warning(f"Failed to upsert user fact {fact}: {e}")
