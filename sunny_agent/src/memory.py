# memory.py
# Purpose: Supabase integration for per-session user context loading and conversation logging.
# Handles: async Supabase client init, user context RPC calls, real-time message logging,
# post-session summarization via Claude, and updating users.profile_summary with a
# concise prose paragraph that merges existing knowledge with new session facts.
#
# profile_summary approach (replaces user_facts upsert):
#   - _generate_summary() now produces a "profile_summary" key in addition to
#     "summary", "facts", and "concerns". The profile_summary is a ~150-word prose
#     paragraph describing what Sunny knows about the user, built by merging the
#     existing profile_summary with new information from the current conversation.
#   - _store_summary() writes this paragraph to users.profile_summary via a direct
#     UPDATE, and no longer calls upsert_user_fact for individual key-value facts.
#   - extracted facts (list of dicts) are still stored in session_summaries for audit.
#
# Session context (NOTIFY-1):
#   - resolve_session_context() reads trigger/reminder_id/adherence_log_id from
#     participant metadata alongside user_id so the agent knows how the session started.
#   - create_conversation() now accepts trigger, reminder_id, adherence_log_id and
#     writes them to the conversations row (columns added in migration 008).
#
# Last modified: 2026-02-28

import json
import logging
import os
from datetime import datetime, timezone

from anthropic import AsyncAnthropic
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
                    logger.info(
                        f"Resolved user_id={user_id} from participant {identity}"
                    )
                    return user_id
            except (json.JSONDecodeError, KeyError):
                pass
    logger.warning("No user_id found in participant metadata, using fallback user_id")
    return FALLBACK_USER_ID


def resolve_session_context(room) -> dict:
    """
    purpose: Extract session-trigger context from the first remote participant's metadata JSON.
             Returns trigger type, reminder UUID, and adherence log UUID when present.
             Defaults to trigger='app_open' with None for reminder fields if no metadata found.
    @param room: (livekit.rtc.Room) The connected LiveKit room.
    @return: (dict) Keys: trigger (str), reminder_id (str|None), adherence_log_id (str|None).
    """
    for _identity, participant in room.remote_participants.items():
        if participant.metadata:
            try:
                data = json.loads(participant.metadata)
                return {
                    "trigger": data.get("trigger", "app_open"),
                    "reminder_id": data.get("reminder_id"),
                    "adherence_log_id": data.get("adherence_log_id"),
                }
            except (json.JSONDecodeError, KeyError):
                pass
    return {"trigger": "app_open", "reminder_id": None, "adherence_log_id": None}


async def load_user_context(client: AsyncClient, user_id: str) -> dict:
    """
    purpose: Call the get_user_context RPC to load profile, facts, summaries,
             and reminders for a user. Returns {} on any error.
    @param client: (AsyncClient) Supabase async client.
    @param user_id: (str) UUID of the user to load context for.
    @return: (dict) Context dict with keys: profile, facts, summaries, reminders.
             profile now includes a 'profile_summary' key (may be empty string).
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


async def create_conversation(
    client: AsyncClient,
    user_id: str,
    trigger: str | None = None,
    reminder_id: str | None = None,
    adherence_log_id: str | None = None,
) -> str:
    """
    purpose: Insert a new row in the conversations table and return its UUID.
             Optionally records the session trigger type and associated reminder/adherence
             context (columns added in migration 008) for analytics and agent context.
    @param client: (AsyncClient) Supabase async client.
    @param user_id: (str) UUID of the user this conversation belongs to.
    @param trigger: (str|None) What initiated the session: 'app_open', 'notification_tap', etc.
    @param reminder_id: (str|None) UUID of the reminders row that fired this session.
    @param adherence_log_id: (str|None) UUID of the adherence_log row for this check-in.
    @return: (str) UUID of the newly created conversation, or "" on failure.
    """
    try:
        row: dict = {"user_id": user_id, "status": "active"}
        if trigger:
            row["trigger"] = trigger
        if reminder_id:
            row["reminder_id"] = reminder_id
        if adherence_log_id:
            row["adherence_log_id"] = adherence_log_id

        result = await client.table("conversations").insert(row).execute()
        conversation_id = result.data[0]["id"]
        logger.info(
            f"Created conversation {conversation_id} for user {user_id} (trigger={trigger})"
        )
        return conversation_id
    except Exception as e:
        logger.warning(f"Failed to create conversation: {e}")
        return ""


class ConversationLogger:
    """
    purpose: Owns a single session's database record, handling real-time message
             logging and post-session finalization (summary generation + profile update).
             At session end, generates a Claude summary that includes a merged
             profile_summary prose paragraph, then writes it to users.profile_summary.
    """

    def __init__(
        self,
        client: AsyncClient,
        user_id: str,
        conversation_id: str,
        existing_profile_summary: str = "",
    ) -> None:
        """
        purpose: Initialize the logger with references to the Supabase client and
                 the IDs needed for all DB operations in this session.
        @param client: (AsyncClient) Supabase async client.
        @param user_id: (str) UUID of the user.
        @param conversation_id: (str) UUID of the conversation row for this session.
        @param existing_profile_summary: (str) Current users.profile_summary value,
               used as the baseline when generating the updated profile prose paragraph.
        """
        self._client = client
        self._user_id = user_id
        self._conversation_id = conversation_id
        self._existing_profile_summary = existing_profile_summary
        self._finalized: bool = False

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
            await (
                self._client.table("messages")
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
                f"Failed to log {role} message (conversation={self._conversation_id}): {e}"
            )

    async def finalize(self, chat_history) -> None:
        """
        purpose: Called at session shutdown. Marks the conversation completed,
                 generates a Claude summary of the transcript (including an updated
                 profile_summary paragraph), and stores results to Supabase.
                 Idempotent: the second call (from _on_shutdown when _on_participant_disconnected
                 already ran) returns immediately without touching the DB.
                 A failure updating conversations.status is non-critical and does not
                 prevent summary generation — the summary path always runs if there is
                 transcript content.
        @param chat_history: (ChatContext) The session's full chat history from
                             AgentSession.history. Items filtered to user/assistant
                             ChatMessage instances only.
        """
        if self._finalized or not self._conversation_id:
            return
        self._finalized = True

        # Mark conversation ended
        try:
            await (
                self._client.table("conversations")
                .update(
                    {
                        "ended_at": datetime.now(timezone.utc).isoformat(),
                        "status": "completed",
                    }
                )
                .eq("id", self._conversation_id)
                .execute()
            )
        except Exception as e:
            logger.warning(f"Failed to mark conversation as completed: {e}")
            # Non-critical — continue to summary generation regardless

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
        result = await self._generate_summary(
            transcript, self._existing_profile_summary
        )

        summary = result.get("summary", "")
        facts = result.get("facts", [])
        concerns = result.get("concerns", [])
        profile_summary = result.get("profile_summary", "")

        logger.info(f"Summary: {summary}")
        if profile_summary:
            logger.info(f"Profile summary updated ({len(profile_summary)} chars)")
        if facts:
            for f in facts:
                logger.info(
                    f"  Extracted fact — {f.get('category')}/{f.get('key')}: {f.get('value')}"
                )
        else:
            logger.info("  No facts extracted")
        if concerns:
            for c in concerns:
                logger.warning(f"  Flagged concern: {c}")

        await self._store_summary(summary, facts, concerns, profile_summary)
        logger.info(f"Session finalized for conversation {self._conversation_id}")

    async def _generate_summary(self, transcript: str, existing_profile: str) -> dict:
        """
        purpose: Call Claude asynchronously to produce a structured summary of the
                 session transcript. Generates both a session summary and an updated
                 profile_summary prose paragraph that merges existing knowledge with
                 new information from this conversation. Uses AsyncAnthropic to avoid
                 blocking the event loop during finalization.
        @param transcript: (str) Newline-joined "ROLE: content" lines from the session.
        @param existing_profile: (str) The user's current profile_summary (may be empty
               for new users). Used as baseline for the merged profile paragraph.
        @return: (dict) Keys: summary (str), facts (list of dicts), concerns (list of str),
                 profile_summary (str).
        """
        existing_section = (
            f"Existing profile paragraph:\n{existing_profile}\n\n"
            if existing_profile
            else "No existing profile yet.\n\n"
        )
        prompt = (
            "You are analyzing a conversation between a voice assistant (Sunny) and an elderly user.\n\n"
            f"{existing_section}"
            f"Conversation transcript:\n{transcript}\n\n"
            "Generate a JSON response with exactly these keys:\n"
            '1. "summary": A 2-3 sentence summary of what was discussed in this session.\n'
            '2. "facts": A list of facts learned about the user. Each fact is an object with '
            '"category" (one of: medication, health, preference, personal, device), "key", and "value".\n'
            '3. "concerns": A list of any health or safety concerns mentioned (plain strings). '
            "Empty list if none.\n"
            '4. "profile_summary": A concise prose paragraph (max 150 words) describing what '
            "Sunny knows about this user. Merge the existing profile paragraph with any new "
            "information learned in this conversation. Write it as useful context Sunny can "
            "read at the start of a future session — include name preferences, health background, "
            "device comfort level, communication style, and any recurring topics. Omit trivial "
            "or one-off details. If the existing profile is empty, build it solely from this session.\n\n"
            "Respond with valid JSON only, no markdown or other text."
        )
        try:
            logger.info(
                f"Calling {SUMMARY_MODEL} to summarize transcript ({len(transcript.splitlines())} lines)"
            )
            sdk_client = AsyncAnthropic()
            response = await sdk_client.messages.create(
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
                "profile_summary": parsed.get("profile_summary", ""),
            }
        except Exception as e:
            logger.warning(f"Failed to generate session summary: {e}")
            return {"summary": "", "facts": [], "concerns": [], "profile_summary": ""}

    async def _store_summary(
        self,
        summary: str,
        facts: list,
        concerns: list,
        profile_summary: str,
    ) -> None:
        """
        purpose: Insert the generated summary into session_summaries and update
                 users.profile_summary with the new merged prose paragraph.
                 No longer writes individual facts to user_facts; extracted facts
                 are stored only in session_summaries.extracted_facts for audit.
        @param summary: (str) Human-readable session summary.
        @param facts: (list) List of dicts with keys: category, key, value.
        @param concerns: (list) List of plain-string health/safety concern descriptions.
        @param profile_summary: (str) Updated prose paragraph describing the user;
               written to users.profile_summary if non-empty.
        """
        try:
            await (
                self._client.table("session_summaries")
                .insert(
                    {
                        "conversation_id": self._conversation_id,
                        "summary": summary,
                        "extracted_facts": facts,
                        "flagged_concerns": concerns,
                    }
                )
                .execute()
            )
        except Exception as e:
            logger.warning(
                f"Failed to store session summary (conversation={self._conversation_id}): {e}"
            )
            return

        if profile_summary:
            try:
                await (
                    self._client.table("users")
                    .update(
                        {
                            "profile_summary": profile_summary,
                        }
                    )
                    .eq("id", self._user_id)
                    .execute()
                )
                logger.info(f"Updated profile_summary for user {self._user_id}")
            except Exception as e:
                logger.warning(
                    f"Failed to update profile_summary for user {self._user_id}: {e}"
                )
