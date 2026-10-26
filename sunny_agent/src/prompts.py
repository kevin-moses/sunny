# prompts.py
# Purpose: System prompt template and user context formatting for the Sunny voice agent.
# Provides the senior-optimized assistant persona and functions to inject per-user
# context (profile_summary, conversation summaries, reminders) into the system prompt
# at session start. profile_summary is a free-text prose paragraph written by Claude at
# session end that replaces the fragmented user_facts key-value approach.
# The system prompt includes guidance for managing Sunny (Supabase-backed) reminders
# with a voice-friendly confirmation flow.
# Memory-care pivot: removed GUIDED WORKFLOWS, SCREEN SHARING, VISION MODE sections,
# iOS native reminder guidance, format_step_context(), and the iOS version from the user
# context line. The privacy rule from VISION MODE moved to COMMUNICATION STYLE. The
# persona rewrite to the SPEC voice guardrails is a separate step.
#
# Last modified: 2026-10-24

from __future__ import annotations

SYSTEM_PROMPT_TEMPLATE = """You are Sunny, a warm and patient voice assistant designed specifically for older adults. \
Your role is to make phone interactions easier and more accessible.

== CORE BEHAVIORS ==
Speak clearly and naturally using simple, familiar words. Avoid technical jargon.
Keep responses to 2-3 sentences maximum unless the user asks for more detail.
Address the user by their first name whenever appropriate.
Give one piece of information or one instruction at a time. Never overwhelm.
If you need a moment to look something up, say so: "Let me check on that for you" or "Give me just a moment."
Never say you cannot help without offering an alternative or a next step.
When the user asks you to pick, choose, or recommend something, do so — make a specific suggestion rather than deflecting back to them.

== COMMUNICATION STYLE ==
Warm, calm, and encouraging — like a knowledgeable friend or family member.
Confirm understanding frequently: "Does that make sense?" or "Would you like me to do that?"
If the user seems confused or repeats themselves, respond with patience.
Avoid complex formatting, emojis, asterisks, bullet points, or symbols — speech only.
Never read passwords, banking details, or private messages aloud.

== TOOLS ==
You have access to web search, reminders, contacts, and messaging. Use them proactively. \
Always confirm before sending messages or creating reminders.

== REMINDERS ==
Reminders (save_reminder / list_reminders / delete_reminder) are stored in Sunny's \
system and trigger push notifications. Use them for medication, appointments, wellness.

When setting a reminder:
1. Parse what they said into type, title, times, and days.
2. Repeat it back before calling the tool: "So I'll remind you to take your blood pressure \
medication at 9 AM and 9 PM every day. Does that sound right?"
3. Only call save_reminder AFTER the user confirms.

When deleting: confirm which reminder you're cancelling before calling delete_reminder. \
If multiple reminders match, list them and ask which one.

== USER CONTEXT ==
{user_context}"""


def format_user_context(context: dict) -> str:
    """
    purpose: Convert a get_user_context RPC response dict into a human-readable
             block suitable for injection into the system prompt. Uses profile_summary
             (a free-text prose paragraph) instead of the old facts-by-category table,
             producing cleaner, less token-wasteful context for the LLM.
    @param context: (dict) Response from the get_user_context RPC. Expected keys:
                   profile (includes profile_summary), summaries, reminders.
                   Pass {} for new users.
    @return: (str) A formatted multi-line string describing what Sunny knows about
             the user, or a brief fallback message if the context is empty.
    """
    if not context:
        return "No prior context available. This appears to be a new user."

    profile = context.get("profile", {})
    summaries = context.get("summaries", [])
    reminders = context.get("reminders", [])

    name = profile.get("name", "the user")
    timezone = profile.get("timezone", "unknown")
    profile_summary = profile.get("profile_summary", "")

    lines = [
        f"Name: {name} | Timezone: {timezone}",
    ]

    # Profile summary (replaces facts-by-category)
    if profile_summary:
        lines.append("")
        lines.append(f"What Sunny knows about {name}:")
        lines.append(profile_summary)

    # Recent session summaries (last 5)
    if summaries:
        lines.append("")
        lines.append("Recent conversations (last 5):")
        for s in summaries[:5]:
            summary_text = s.get("summary", "")
            created_at = s.get("created_at", "")
            if summary_text:
                date_prefix = created_at[:10] if created_at else "unknown date"
                lines.append(f"  - {date_prefix}: {summary_text}")

    # Active reminders
    if reminders:
        lines.append("")
        lines.append("Active reminders:")
        for r in reminders:
            title = r.get("title", "")
            rtype = r.get("type", "")
            description = r.get("description", "")
            entry = f"  - {title}"
            if rtype:
                entry += f" ({rtype})"
            if description:
                entry += f": {description}"
            lines.append(entry)

    return "\n".join(lines)


def render_system_prompt(user_context_block: str) -> str:
    """
    purpose: Inject the formatted user context block into the system prompt template.
    @param user_context_block: (str) Output of format_user_context().
    @return: (str) The complete system prompt string ready for the LLM.
    """
    return SYSTEM_PROMPT_TEMPLATE.format(user_context=user_context_block)
