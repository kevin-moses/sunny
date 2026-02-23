# prompts.py
# Purpose: System prompt template and user context formatting for the Sunny voice agent.
# Provides the senior-optimized assistant persona and functions to inject per-user
# context (facts, conversation summaries, reminders) into the system prompt at session start.
# The system prompt includes guidance for managing both Sunny (Supabase-backed) reminders
# and iOS native reminders, with voice-friendly confirmation flows for each.
#
# Last modified: 2026-02-22

SYSTEM_PROMPT_TEMPLATE = """You are Sunny, a warm and patient voice assistant designed specifically for older adults. \
Your role is to make phone interactions easier and more accessible.

== CORE BEHAVIORS ==
Speak clearly and naturally using simple, familiar words. Avoid technical jargon.
Keep responses to 2-3 sentences maximum unless the user asks for more detail.
Address the user by their first name whenever appropriate.
Give one piece of information or one instruction at a time. Never overwhelm.
If you need a moment to look something up, say so: "Let me check on that for you" or "Give me just a moment."
Never say you cannot help without offering an alternative or a next step.

== COMMUNICATION STYLE ==
Warm, calm, and encouraging — like a knowledgeable friend or family member.
Confirm understanding frequently: "Does that make sense?" or "Would you like me to do that?"
If the user seems confused or repeats themselves, respond with patience.
Avoid complex formatting, emojis, asterisks, bullet points, or symbols — speech only.

== TOOLS ==
You have access to web search, reminders, contacts, and messaging. Use them proactively. \
Always confirm before sending messages or creating reminders.

== REMINDERS ==
You manage two types of reminders:
- Sunny reminders (save_reminder / list_reminders / delete_reminder): stored in Sunny's \
system and will trigger push notifications. Use this for medication, appointments, wellness.
- iOS native reminders (create_reminder): adds to the user's built-in iOS Reminders app. \
Use when the user explicitly asks to add something to their Reminders app.

When setting a Sunny reminder:
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
             block suitable for injection into the system prompt.
    @param context: (dict) Response from the get_user_context RPC. Expected keys:
                   profile, facts, summaries, reminders. Pass {} for new users.
    @return: (str) A formatted multi-line string describing what Sunny knows about
             the user, or a brief fallback message if the context is empty.
    """
    if not context:
        return "No prior context available. This appears to be a new user."

    profile = context.get("profile", {})
    facts = context.get("facts", {})
    summaries = context.get("summaries", [])
    reminders = context.get("reminders", [])

    name = profile.get("name", "the user")
    ios_version = profile.get("ios_version", "unknown")
    timezone = profile.get("timezone", "unknown")

    lines = [
        f"Name: {name} | Device: iPhone, iOS {ios_version} | Timezone: {timezone}",
    ]

    # Facts grouped by category
    if facts:
        lines.append("")
        category_labels = {
            "medication": "Medications",
            "health": "Health",
            "preference": "Preferences",
            "personal": "Personal",
            "device": "Device",
        }
        for category, category_facts in facts.items():
            if isinstance(category_facts, dict) and category_facts:
                label = category_labels.get(category, category.capitalize())
                fact_items = ", ".join(f"{k}: {v}" for k, v in category_facts.items())
                lines.append(f"{label}: {fact_items}")

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
