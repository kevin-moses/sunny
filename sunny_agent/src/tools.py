# tools.py
# Purpose: Async helpers behind the agent's task tools, plus voice-friendly time and date
# formatting shared with prompts.py. Every decision lives in the Convex agent:* functions the
# other surfaces also use: agent:today (today's schedule), agent:confirmDueTask (which task
# "Done" means and the already-done guard), agent:createSeniorReminder and
# agent:cancelSeniorReminder (senior-created reminders only). These helpers only call the
# function and phrase the result for voice. Instants arrive as epoch milliseconds. They
# contain no LiveKit imports; the @function_tool methods on Assistant in agent.py call them.
#
# Memory-care pivot (2026-10-25): replaced reminders-table CRUD with household task RPCs.
# Convex migration (2026-10-29): RPCs became Convex calls; timestamps are epoch ms.
#
# Anytime tasks (2026-11-01): a task with no time of day arrives with scheduledTime "anytime"
# (ANYTIME). It is spoken as "<label>, anytime today" and is never "due now" or "not due until".
#
# Voice tools (2026-11-09): db_snooze_task (agent:snoozeDueTask, "not yet"),
# db_medication_status (agent:medicationStatus) and db_log_dose (agent:logAsNeededDose) with
# describe_as_needed for the label facts, db_remember_fact (agent:rememberFact),
# db_flag_caregiver (agent:flagCaregiver), db_send_family_message (agent:sendFamilyMessage) and
# db_read_latest_message (agent:readLatestMessage). The results are facts for the model to
# phrase, never advice: a medication result states what was taken and what the label says.
# one_line and quoted keep family-written text to one line (and a message body in quotes) in
# the context block and tool results.
#
# Last modified: 2026-11-09

from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from convex_client import ConvexClient

_DAY_ORDER = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
_DONE_STATES = {"confirmed", "resolved"}
# scheduledTime of an anytime task (no time of day). Mirrors ANYTIME in
# sunny_backend/convex/lib/anytime.ts; keep the two in sync.
ANYTIME = "anytime"


def format_time_for_voice(t: str) -> str:
    """
    purpose: Convert a 24-hour time string to a voice-friendly spoken form.
    @param t: (str) Time in "HH:MM" or "HH:MM:SS" 24-hour format.
    @return: (str) Spoken time, e.g. "9 AM", "9:30 PM", "noon", "midnight".
    """
    parts = t.split(":")
    if len(parts) < 2:
        return t
    hour = int(parts[0])
    minute = int(parts[1])

    if hour == 0 and minute == 0:
        return "midnight"
    if hour == 12 and minute == 0:
        return "noon"

    period = "AM" if hour < 12 else "PM"
    display_hour = hour if hour <= 12 else hour - 12
    if display_hour == 0:
        display_hour = 12

    if minute == 0:
        return f"{display_hour} {period}"
    return f"{display_hour}:{minute:02d} {period}"


def format_days_for_voice(days: list[str]) -> str:
    """
    purpose: Convert a list of day abbreviations to a voice-friendly spoken form.
    @param days: (list[str]) Day abbreviations from ["mon","tue","wed","thu","fri","sat","sun"].
    @return: (str) Spoken day string, e.g. "every day", "on weekdays", "on Mon, Tue".
    """
    day_set = {d.lower() for d in days}
    if day_set == set(_DAY_ORDER):
        return "every day"
    if day_set == set(_DAY_ORDER[:5]):
        return "on weekdays"
    if day_set == set(_DAY_ORDER[5:]):
        return "on weekends"
    return "on " + ", ".join(d.capitalize() for d in _DAY_ORDER if d in day_set)


def to_local(epoch_ms: float, tz: str) -> datetime:
    """
    purpose: Convert a Convex instant (epoch milliseconds) to the household's local time.
    @param epoch_ms: (float) Milliseconds since the Unix epoch.
    @param tz: (str) IANA timezone of the household.
    @return: (datetime) Aware datetime in the household timezone.
    """
    return datetime.fromtimestamp(epoch_ms / 1000, tz=timezone.utc).astimezone(
        ZoneInfo(tz)
    )


def clock_for_voice(moment: datetime) -> str:
    """
    purpose: Spoken clock time of a datetime.
    @param moment: (datetime) Any datetime (already in the desired timezone).
    @return: (str) e.g. "8:10 AM".
    """
    return format_time_for_voice(moment.strftime("%H:%M"))


def spoken_date(day: date) -> str:
    """
    purpose: Spoken weekday and date, e.g. "Tuesday, January 5".
    @param day: (date) The date to describe.
    @return: (str) Weekday, month and day without a leading zero.
    """
    return f"{day.strftime('%A, %B')} {day.day}"


def local_clock(epoch_ms: float, tz: str) -> str:
    """
    purpose: Spoken local time of an instant in the household timezone.
    @param epoch_ms: (float) Milliseconds since the Unix epoch.
    @param tz: (str) IANA timezone of the household.
    @return: (str) e.g. "8:10 AM".
    """
    return clock_for_voice(to_local(epoch_ms, tz))


def describe_instance(item: dict, tz: str) -> str:
    """
    purpose: Describe one of today's task instances for voice.
    @param item: (dict) Entry from agent:today / agent:getContext()['today'] (camelCase keys).
    @param tz: (str) IANA timezone of the household.
    @return: (str) e.g. "8 AM, Morning pills: done at 8:10 AM"; for an anytime task
             "Water plants, anytime today: still to do today".
    """
    label = item.get("displayLabel", "")
    anytime = item.get("scheduledTime", "") == ANYTIME
    state = item.get("state", "")
    if anytime:
        when = f"{label}, anytime today"
        open_status = "still to do today"
    else:
        when = f"{format_time_for_voice(item.get('scheduledTime', ''))}, {label}"
        open_status = "due now"
    if state in _DONE_STATES and item.get("confirmedAt"):
        status = f"done at {local_clock(item['confirmedAt'], tz)}"
    elif (anytime and state != "missed") or state in ("due", "escalated"):
        status = open_status
    elif state == "missed":
        status = "not done yet"
    else:
        status = "later today"
    return f"{when}: {status}"


async def db_list_today(client: ConvexClient, household_id: str, tz: str) -> str:
    """
    purpose: Describe today's schedule and what has been done, for voice.
    @param client: (ConvexClient) Convex client.
    @param household_id: (str) Household id.
    @param tz: (str) IANA timezone of the household.
    @return: (str) Voice-friendly listing of today's tasks, or a message if there are none.
    """
    items = await client.query("agent:today", {"householdId": household_id}) or []
    if not items:
        return "There is nothing on the schedule for today."
    return "Today: " + "; ".join(describe_instance(i, tz) for i in items) + "."


async def db_confirm_task(
    client: ConvexClient, household_id: str, tz: str, task_name: str
) -> str:
    """
    purpose: Confirm one of today's tasks by voice through agent:confirmDueTask, which picks
             the task (the due one when no name is given) and guards against confirming
             twice. Phrases each outcome for the agent.
    @param client: (ConvexClient) Convex client.
    @param household_id: (str) Household id.
    @param tz: (str) IANA timezone of the household.
    @param task_name: (str) Name or part of the task's label, or "" for whatever is due.
    @return: (str) Voice-friendly outcome: confirmed, already done, nothing due, not
             found, not due yet, or a clarifying question.
    """
    r = (
        await client.mutation(
            "agent:confirmDueTask",
            {"householdId": household_id, "label": task_name or None},
        )
        or {}
    )
    status = r.get("status")
    label = r.get("displayLabel", task_name)
    if status == "confirmed":
        return f"Confirmed: {label} at {local_clock(r['confirmedAt'], tz)}."
    if status == "already_done":
        return f"Already done: {label} was confirmed at {local_clock(r['confirmedAt'], tz)}."
    if status == "nothing_due":
        return "Nothing is due right now."
    if status == "not_due_yet":
        if r.get("scheduledTime") == ANYTIME:
            return f"{label} is not ready to be marked done yet."
        return f"{label} is not due until {format_time_for_voice(r['scheduledTime'])}."
    if status == "ambiguous":
        options = "; ".join(describe_instance(o, tz) for o in r.get("options") or [])
        return f"Several tasks match: {options}. Ask which one they mean."
    return f"I don't see {task_name} on today's schedule."


async def db_create_senior_reminder(
    client: ConvexClient,
    household_id: str,
    tz: str,
    title: str,
    time: str,
    on_date: str = "",
    days: list[str] | None = None,
) -> str:
    """
    purpose: Create a reminder the senior asked for through agent:createSeniorReminder, which
             sets the senior-created defaults (prompt-only policy, wording, window).
             One-off when on_date is given, otherwise recurring on days (every day if empty).
    @param client: (ConvexClient) Convex client.
    @param household_id: (str) Household id.
    @param tz: (str) IANA timezone of the household, used to phrase the date.
    @param title: (str) What to remind them about, e.g. "call the plumber".
    @param time: (str) 24-hour "HH:MM".
    @param on_date: (str) "YYYY-MM-DD" for a one-off reminder, or "".
    @param days: (list[str] | None) Day abbreviations for a recurring reminder.
    @return: (str) Voice-friendly confirmation.
    """
    day_list = [d.lower() for d in (days or []) if d.lower() in _DAY_ORDER]
    await client.mutation(
        "agent:createSeniorReminder",
        {
            "householdId": household_id,
            "title": title,
            "time": time,
            "onDate": on_date or None,
            "days": [_DAY_ORDER.index(d) + 1 for d in day_list] or None,
        },
    )

    spoken_time = format_time_for_voice(time)
    if not on_date:
        days_str = format_days_for_voice(day_list or _DAY_ORDER)
        return f"Done. I'll remind you to {title} at {spoken_time} {days_str}."
    today = datetime.now(ZoneInfo(tz)).date()
    target = date.fromisoformat(on_date)
    if target == today:
        when = "today"
    elif target == today + timedelta(days=1):
        when = "tomorrow"
    else:
        when = f"on {spoken_date(target)}"
    return f"Done. I'll remind you to {title} {when} at {spoken_time}."


async def db_cancel_senior_reminder(
    client: ConvexClient, household_id: str, title_query: str
) -> str:
    """
    purpose: Cancel a reminder the senior created through agent:cancelSeniorReminder.
             Caregiver-created tasks are never matched.
    @param client: (ConvexClient) Convex client.
    @param household_id: (str) Household id.
    @param title_query: (str) Name or part of the reminder's title.
    @return: (str) Voice-friendly outcome: cancelled, not found, or a clarifying question.
    """
    r = (
        await client.mutation(
            "agent:cancelSeniorReminder",
            {"householdId": household_id, "query": title_query},
        )
        or {}
    )
    titles = r.get("titles") or []
    if r.get("status") == "cancelled":
        return f"Cancelled the reminder to {titles[0]}."
    if r.get("status") == "ambiguous":
        return f"Several reminders match: {', '.join(titles)}. Ask which one to cancel."
    return (
        f"No reminder they created matches '{title_query}'. Reminders set up by "
        "family can only be changed by family."
    )


def one_line(value: object) -> str:
    """
    purpose: Household text as one line: every run of whitespace, newlines included, becomes
             a single space, so caregiver-written text cannot add lines to the prompt.
    @param value: (object) Any value; None becomes "".
    @return: (str) The trimmed single-line text.
    """
    return " ".join(str(value or "").split())


def quoted(text: object) -> str:
    """
    purpose: Family-written text in double quotes on one line, its own double quotes turned
             into single quotes so the quoted span cannot be closed early.
    @param text: (object) The text.
    @return: (str) e.g. '"Coming at 2 with soup"'.
    """
    return '"' + one_line(text).replace('"', "'") + '"'


def join_names(names: list[str]) -> str:
    """
    purpose: Join names the way people say them.
    @param names: (list[str]) Names in order.
    @return: (str) "Anna", "Anna and Bob", "Anna, Bob and Sarah", or "family" when empty.
    """
    if not names:
        return "family"
    if len(names) == 1:
        return names[0]
    return f"{', '.join(names[:-1])} and {names[-1]}"


def _same_local_day(a_ms: float, b_ms: float, tz: str) -> bool:
    """
    purpose: Whether two instants fall on the same household-local date.
    @param a_ms: (float) Epoch ms.
    @param b_ms: (float) Epoch ms.
    @param tz: (str) IANA timezone of the household.
    @return: (bool) True on the same local date.
    """
    return to_local(a_ms, tz).date() == to_local(b_ms, tz).date()


def describe_as_needed(med: dict, tz: str, now_ms: float | None = None) -> str:
    """
    purpose: State the facts about one as-needed medication: label limits, doses today and,
             when now_ms is given, when another would be within the label. Facts only; the
             decision stays with the senior.
    @param med: (dict) AsNeededEntry from agent:medicationStatus / getContext (camelCase).
    @param tz: (str) IANA timezone of the household.
    @param now_ms: (float | None) Epoch ms the facts are read at; None leaves out the
                   time-dependent sentence (the session-start context goes stale).
    @return: (str) e.g. "Pain reliever (small white): the label says up to 3 a day, at least
             6 hours apart. Taken today: 11 AM (1 of 3). Another would be within the label
             after 5 PM."
    """
    label = med.get("displayLabel", "")
    if med.get("pillDescription"):
        label += f" ({med['pillDescription']})"
    limits = []
    max_per_day = med.get("maxPerDay")
    if max_per_day:
        limits.append(f"up to {max_per_day} a day")
    if med.get("minHoursBetween"):
        limits.append(f"at least {float(med['minHoursBetween']):g} hours apart")
    label_text = (
        f"the label says {', '.join(limits)}" if limits else "no limits are on file"
    )
    taken = [local_clock(t, tz) for t in med.get("takenToday") or []]
    taken_text = ", ".join(taken) if taken else "none"
    if max_per_day:
        taken_text += f" ({len(taken)} of {max_per_day})"
    text = f"{label}: {label_text}. Taken today: {taken_text}."
    if now_ms is None:
        return text
    next_at = med.get("nextWithinLabelAt")
    if next_at is None:
        return f"{text} Another would be within the label now."
    if med.get("remainingToday") == 0:
        return f"{text} That is the most the label allows today."
    day = "" if _same_local_day(next_at, now_ms, tz) else " tomorrow"
    return f"{text} Another would be within the label after {local_clock(next_at, tz)}{day}."


async def db_snooze_task(
    client: ConvexClient, household_id: str, tz: str, task_name: str
) -> str:
    """
    purpose: "Not yet": snooze the due task's prompts 15 minutes through
             agent:snoozeDueTask, which picks the task the same way "Done" does.
    @param client: (ConvexClient) Convex client.
    @param household_id: (str) Household id.
    @param tz: (str) IANA timezone of the household.
    @param task_name: (str) Name or part of the task's label, or "" for whatever is due.
    @return: (str) Voice-friendly outcome.
    """
    r = (
        await client.mutation(
            "agent:snoozeDueTask",
            {"householdId": household_id, "label": task_name or None},
        )
        or {}
    )
    status = r.get("status")
    label = r.get("displayLabel") or task_name
    if status == "snoozed":
        return f"Snoozed {label}; the next reminder is at {local_clock(r['snoozedUntil'], tz)}."
    if status == "already_done":
        return f"Already done: {label} was confirmed at {local_clock(r['confirmedAt'], tz)}."
    if status == "not_due_yet":
        return f"{label} is not due until {format_time_for_voice(r['scheduledTime'])}."
    if status == "ambiguous":
        return f"Several tasks are due: {', '.join(r.get('options') or [])}. Ask which one."
    if status == "not_found":
        return f"I don't see {task_name} on today's schedule."
    return "Nothing is due right now."


async def db_medication_status(client: ConvexClient, household_id: str, tz: str) -> str:
    """
    purpose: The facts for a medication question, read fresh through agent:medicationStatus:
             today's scheduled medications and their state, then each as-needed medication's
             label limits, doses today and when another would be within the label.
    @param client: (ConvexClient) Convex client.
    @param household_id: (str) Household id.
    @param tz: (str) IANA timezone of the household.
    @return: (str) Voice-friendly facts.
    """
    r = (
        await client.query("agent:medicationStatus", {"householdId": household_id})
        or {}
    )
    now_ms = datetime.now(timezone.utc).timestamp() * 1000
    scheduled = r.get("scheduled") or []
    as_needed = r.get("asNeeded") or []
    parts = []
    if scheduled:
        parts.append(
            "Scheduled medications today: "
            + "; ".join(describe_instance(i, tz) for i in scheduled)
            + "."
        )
    else:
        parts.append("No scheduled medications today.")
    if as_needed:
        parts.extend(describe_as_needed(m, tz, now_ms) for m in as_needed)
    else:
        parts.append(
            "No as-needed medication rule is on file from family, so there is no label "
            "limit to give."
        )
    return " ".join(parts)


async def db_log_dose(
    client: ConvexClient,
    household_id: str,
    tz: str,
    medication: str,
    minutes_ago: int,
    conversation_id: str | None,
) -> str:
    """
    purpose: Log an as-needed dose the senior says they took through agent:logAsNeededDose,
             which also flags the caregiver when the dose goes past a label limit. Nothing is
             logged when no as-needed rule matches.
    @param client: (ConvexClient) Convex client.
    @param household_id: (str) Household id.
    @param tz: (str) IANA timezone of the household.
    @param medication: (str) Words naming the medication, or "" when only one is on file.
    @param minutes_ago: (int) Whole minutes since they took it (0 = just now).
    @param conversation_id: (str | None) The conversation, if one was opened.
    @return: (str) Voice-friendly facts after the dose, or why nothing was logged.
    """
    r = (
        await client.mutation(
            "agent:logAsNeededDose",
            {
                "householdId": household_id,
                "label": medication or None,
                "minutesAgo": max(0, int(minutes_ago)),
                "conversationId": conversation_id or None,
            },
        )
        or {}
    )
    status = r.get("status")
    options = ", ".join(r.get("options") or [])
    if status == "no_rule":
        return (
            "Nothing was logged: family has not set up an as-needed medication with label "
            "limits. Say what was taken today if asked, and offer to let family know."
        )
    if status == "not_found":
        return (
            f"Nothing was logged: no as-needed medication matches. On file: {options}."
        )
    if status == "ambiguous":
        return f"Nothing was logged yet: ask which one they took: {options}."
    med = r["medication"]
    text = (
        f"Logged {med.get('displayLabel', '')} at {local_clock(r['takenAt'], tz)}. "
        f"{describe_as_needed(med, tz, r['takenAt'])}"
    )
    breaches = []
    if r.get("overDailyMax"):
        breaches.append("more than the label's daily limit")
    if r.get("tooSoon"):
        breaches.append("sooner than the label's hours apart")
    if breaches:
        text += (
            f" This dose is {' and '.join(breaches)}. "
            f"{join_names(r.get('flagged') or [])} has been told."
        )
    return text


async def db_remember_fact(
    client: ConvexClient, household_id: str, fact: str, conversation_id: str | None
) -> str:
    """
    purpose: Note something the senior said (unverified until family confirms it) through
             agent:rememberFact. Never changes an existing fact.
    @param client: (ConvexClient) Convex client.
    @param household_id: (str) Household id.
    @param fact: (str) The fact in a full sentence, e.g. "Margaret's glasses are in the hall
                 drawer."
    @param conversation_id: (str | None) The conversation, if one was opened.
    @return: (str) Voice-friendly outcome.
    """
    r = (
        await client.mutation(
            "agent:rememberFact",
            {
                "householdId": household_id,
                "fact": fact,
                "conversationId": conversation_id or None,
            },
        )
        or {}
    )
    if r.get("status") == "already_known":
        return "That was already noted."
    return "Noted."


async def db_flag_caregiver(
    client: ConvexClient,
    household_id: str,
    reason: str,
    detail: str,
    conversation_id: str | None,
) -> str:
    """
    purpose: Ask the on-call caregiver (or every caregiver) to look in, through
             agent:flagCaregiver.
    @param client: (ConvexClient) Convex client.
    @param household_id: (str) Household id.
    @param reason: (str) medication_limit, symptom, money_request, scam, distress or
                   help_requested.
    @param detail: (str) One or two sentences for the caregiver.
    @param conversation_id: (str | None) The conversation, if one was opened.
    @return: (str) Who was told.
    """
    r = (
        await client.mutation(
            "agent:flagCaregiver",
            {
                "householdId": household_id,
                "reason": reason,
                "detail": detail,
                "conversationId": conversation_id or None,
            },
        )
        or {}
    )
    names = join_names(r.get("notified") or [])
    if r.get("status") == "already_flagged":
        return f"{names} was already told about this a few minutes ago."
    return f"{names} has been told."


async def db_send_family_message(
    client: ConvexClient,
    household_id: str,
    to: str,
    message: str,
    conversation_id: str | None,
) -> str:
    """
    purpose: Send a message the senior dictated to family through agent:sendFamilyMessage
             (the Sunny app, not a phone text).
    @param client: (ConvexClient) Convex client.
    @param household_id: (str) Household id.
    @param to: (str) The name they used, or "" for the family.
    @param message: (str) The message, in their words.
    @param conversation_id: (str | None) The conversation, if one was opened.
    @return: (str) Who got it.
    """
    r = (
        await client.mutation(
            "agent:sendFamilyMessage",
            {
                "householdId": household_id,
                "to": to or None,
                "body": message,
                "conversationId": conversation_id or None,
            },
        )
        or {}
    )
    names = join_names(r.get("recipients") or [])
    if r.get("status") == "sent_to_family":
        return f"{to} is not set up in Sunny, so the message went to {names}."
    return f"Sent to {names}."


def _spoken_when(epoch_ms: float, tz: str) -> str:
    """
    purpose: When something was sent, relative to today.
    @param epoch_ms: (float) Epoch ms.
    @param tz: (str) IANA timezone of the household.
    @return: (str) "today at 9 AM", "yesterday at 6 PM", or "on Monday, March 8".
    """
    moment = to_local(epoch_ms, tz)
    today = datetime.now(ZoneInfo(tz)).date()
    if moment.date() == today:
        return f"today at {clock_for_voice(moment)}"
    if moment.date() == today - timedelta(days=1):
        return f"yesterday at {clock_for_voice(moment)}"
    return f"on {spoken_date(moment)}"


async def db_read_latest_message(
    client: ConvexClient, household_id: str, tz: str
) -> str:
    """
    purpose: The newest family message for reading aloud, through agent:readLatestMessage
             (which marks it seen).
    @param client: (ConvexClient) Convex client.
    @param household_id: (str) Household id.
    @param tz: (str) IANA timezone of the household.
    @return: (str) Who sent it, when, and what it says; or that there is none.
    """
    r = await client.mutation("agent:readLatestMessage", {"householdId": household_id})
    if not r:
        return "There are no messages from family."
    sender = one_line(r.get("from")) or "family"
    when = _spoken_when(r["sentAt"], tz)
    body = r.get("body")
    photo = r.get("hasPhoto")
    if body and photo:
        return f"From {sender}, {when}, with a photo: {quoted(body)}"
    if body:
        return f"From {sender}, {when}: {quoted(body)}"
    if photo:
        return f"{sender} sent a photo {when}, with no words."
    return f"{sender} sent a message {when} with no words."
