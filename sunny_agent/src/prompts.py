# prompts.py
# Purpose: System prompt template and household context formatting for the Sunny voice
# agent. format_user_context() turns the agent:getContext result (today's schedule,
# as-needed medications, upcoming events, latest family message, life profile,
# sensitive-topic playbook, agent memory, recent conversations) into the context block
# injected into the system prompt at session start. Household facts are labeled by
# source so caregiver-verified facts outrank things the senior said.
# Memory-care pivot: removed GUIDED WORKFLOWS, SCREEN SHARING, VISION MODE sections,
# iOS native reminder guidance, format_step_context(), and the users.profile_summary
# paragraph. The privacy rule from VISION MODE moved to COMMUNICATION STYLE. The REMINDERS
# section became TASKS AND REMINDERS for the household task tools. The persona rewrite to
# the SPEC voice guardrails is a separate step.
# Convex migration (2026-10-29): context keys are camelCase and instants are epoch ms.
#
# Last modified: 2026-10-29

from __future__ import annotations

from datetime import datetime

from config import DEFAULT_TIMEZONE
from tools import (
    clock_for_voice,
    describe_instance,
    local_clock,
    spoken_date,
    to_local,
)

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
You have access to web search, today's schedule, reminders, contacts, and messaging. \
Use them proactively. Always confirm before sending messages or creating reminders.

== TASKS AND REMINDERS ==
The household's schedule is set up by family. Answer questions about it from the \
schedule below, or call list_today for the latest status.
When the user says they did a task ("I took them", "done"), call confirm_task. If it \
was already done, tell them when it was done; never suggest taking a medication again.
When the user asks you to remind them of something, repeat it back first ("So I'll \
remind you to call the plumber tomorrow at 10 AM. Is that right?") and call \
create_reminder only after they agree.
cancel_reminder only cancels reminders the user created; tasks set up by family can \
only be changed by family.

== HOUSEHOLD CONTEXT ==
{user_context}"""


def format_user_context(context: dict) -> str:
    """
    purpose: Convert an agent:getContext result into the household context block for
             the system prompt.
    @param context: (dict) Result of agent:getContext. Expected keys: household, today,
                    asNeeded, events, latestMessage, lifeProfile, sensitiveTopics,
                    memory, recentConversations. Pass {} when no household is known.
    @return: (str) Multi-line context block, or a brief fallback when context is empty.
    """
    if not context:
        return "No household context is available for this session."

    household = context.get("household", {})
    tz = household.get("timezone", DEFAULT_TIMEZONE)
    name = household.get("seniorPreferredName", "the user")
    now_str = ""
    if household.get("localNow"):
        now = datetime.fromisoformat(household["localNow"])
        now_str = f"{spoken_date(now)}, {clock_for_voice(now)}"
    lines = [f"Name: {name} | Timezone: {tz} | Local time now: {now_str}"]

    today = context.get("today", [])
    lines.append("")
    if today:
        lines.append("Today's schedule:")
        for item in today:
            entry = f"  - {describe_instance(item, tz)}"
            if item.get("pillDescription"):
                entry += f" (pills: {item['pillDescription']})"
            if item.get("checklistItems"):
                entry += f" (checklist: {', '.join(item['checklistItems'])})"
            lines.append(entry)
    else:
        lines.append("Today's schedule: nothing scheduled.")

    as_needed = context.get("asNeeded", [])
    if as_needed:
        lines.append("")
        lines.append("As-needed medications (limits copied from the label by family):")
        for med in as_needed:
            limits = []
            if med.get("maxPerDay"):
                limits.append(f"up to {med['maxPerDay']} a day")
            if med.get("minHoursBetween"):
                hours = float(med["minHoursBetween"])
                limits.append(f"at least {hours:g} hours apart")
            taken = [local_clock(t, tz) for t in med.get("takenToday", [])]
            taken_str = ", ".join(taken) if taken else "none"
            lines.append(
                f"  - {med.get('displayLabel', '')}: {', '.join(limits) or 'no limits on file'}. "
                f"Taken today: {taken_str}."
            )

    events = context.get("events", [])
    if events:
        lines.append("")
        lines.append("Upcoming events (next 7 days):")
        for e in events:
            starts = to_local(e["startsAt"], tz)
            entry = f"  - {spoken_date(starts)}, {clock_for_voice(starts)}: {e.get('title', '')}"
            if e.get("visitorName"):
                entry += f", with {e['visitorName']}"
            if e.get("place"):
                entry += f", at {e['place']}"
            lines.append(entry)

    message = context.get("latestMessage")
    if message:
        lines.append("")
        body = message.get("body") or ("a photo" if message.get("hasPhoto") else "")
        lines.append(
            f"Latest family message, from {message.get('from', 'family')}: {body}"
        )

    profile = context.get("lifeProfile", [])
    if profile:
        lines.append("")
        lines.append("Life profile (from family):")
        for entry in profile:
            detail = f": {entry['details']}" if entry.get("details") else ""
            lines.append(
                f"  - {entry.get('category', '')} - {entry.get('name', '')}{detail}"
            )

    topics = context.get("sensitiveTopics", [])
    if topics:
        lines.append("")
        lines.append("Sensitive topics (follow family's guidance exactly):")
        for t in topics:
            lines.append(
                f"  - If asked about {t.get('topic', '')}: {t.get('guidance', '')}"
            )

    memory = context.get("memory", [])
    if memory:
        lines.append("")
        lines.append(
            "Remembered facts (family-verified facts outrank unverified ones):"
        )
        for m in memory:
            label = (
                "verified"
                if m.get("verified")
                else f"said by {m.get('source', 'senior')}, unverified"
            )
            lines.append(f"  - {m.get('fact', '')} ({label})")

    conversations = context.get("recentConversations", [])
    if conversations:
        lines.append("")
        lines.append("Recent conversations:")
        for c in conversations:
            started = c.get("startedAt")
            day = to_local(started, tz).date().isoformat() if started else ""
            lines.append(f"  - {day}: {c.get('summary', '')}")

    return "\n".join(lines)


def render_system_prompt(user_context_block: str) -> str:
    """
    purpose: Inject the formatted household context block into the system prompt template.
    @param user_context_block: (str) Output of format_user_context().
    @return: (str) The complete system prompt string ready for the LLM.
    """
    return SYSTEM_PROMPT_TEMPLATE.format(user_context=user_context_block)
