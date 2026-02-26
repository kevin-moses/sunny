# prompts.py
# Purpose: System prompt template and user context formatting for the Sunny voice agent.
# Provides the senior-optimized assistant persona and functions to inject per-user
# context (profile_summary, conversation summaries, reminders) into the system prompt
# at session start. profile_summary is a free-text prose paragraph written by Claude at
# session end that replaces the fragmented user_facts key-value approach.
# The system prompt includes guidance for managing both Sunny (Supabase-backed) reminders
# and iOS native reminders, with voice-friendly confirmation flows for each.
# Also provides format_step_context() for injecting active workflow step context into
# LLM tool return values during guided workflow sessions.
#
# Last modified: 2026-02-26

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from workflow_engine import WorkflowStep

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

== GUIDED WORKFLOWS ==
You can guide the user step-by-step through any task on their iPhone.
When the user asks for help navigating their phone, you MUST call the start_workflow()
tool with a short description of what they want to do (e.g. "block a contact",
"adjust screen brightness", "set an alarm"). NEVER describe or guess the steps yourself —
always call start_workflow() so the scripted, tested guide is used.
Do NOT start a workflow without a clear phone-task request from the user.
While a workflow is active, your only job is to respond to the user's progress.
The tool return value tells you exactly what to listen for and what to do next.
Use confirm_step() when the user indicates success. Use go_back_step() if they want
to redo the previous step. Use exit_workflow() if they want to stop.

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
    ios_version = profile.get("ios_version", "unknown")
    timezone = profile.get("timezone", "unknown")
    profile_summary = profile.get("profile_summary", "")

    lines = [
        f"Name: {name} | Device: iPhone, iOS {ios_version} | Timezone: {timezone}",
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


def format_step_context(
    step: WorkflowStep,
    step_num: int,
    total_steps: int,
    workflow_title: str,
) -> str:
    """
    purpose: Build the step context string returned by workflow tools to the LLM.
             Instructs the LLM to speak the step instruction verbatim, then wait
             for the user to respond before calling any follow-up tool.
    @param step: (WorkflowStep) The current step.
    @param step_num: (int) 1-based step number.
    @param total_steps: (int) Total number of steps in the workflow.
    @param workflow_title: (str) Human-readable workflow title.
    @return: (str) Formatted step context block for the LLM.
    """
    lines = [
        f"== ACTIVE WORKFLOW: {workflow_title} (step {step_num} of {total_steps}) ==",
        f'SPEAK TO USER (word for word): "{step.instruction} {step.confirmation_prompt}"',
        "",
        "After speaking, WAIT for the user to respond. Do NOT call confirm_step() yet.",
        "Only call confirm_step() when the user explicitly says they completed the step.",
    ]

    if step.common_issues:
        lines.append("If the user has trouble, respond warmly:")
        for ci in step.common_issues:
            lines.append(f'  - "{ci["issue"]}" -> "{ci["response"]}"')

    if step.fallback:
        lines.append(f'Fallback if stuck: "{step.fallback}"')

    lines.extend(
        [
            "",
            "Call go_back_step() if the user wants to redo the previous step.",
            "Call exit_workflow() if the user wants to stop or asks about something unrelated.",
        ]
    )

    return "\n".join(lines)
