# tools.py
# Purpose: Async helpers behind the agent's household tools, plus voice-friendly time and date
# formatting shared with prompts.py. Every decision lives in the Convex agent:* functions; these
# helpers only call one and phrase its result for the model. They contain no LiveKit imports;
# the @function_tool methods on Assistant in agent.py call them. Instants arrive as epoch
# milliseconds; now_epoch_ms is the one clock, so tests can fix it.
#
# Helpers: db_list_today (agent:today), db_confirm_task (agent:confirmDueTask: which task "Done"
# means and the already-done guard), db_snooze_task (agent:snoozeDueTask, "not yet"),
# db_create_senior_reminder / db_cancel_senior_reminder (senior-created reminders only),
# db_medication_status, db_log_dose and db_undo_last_dose (as-needed doses, with
# describe_as_needed for the label facts), db_remember_fact, db_flag_caregiver,
# db_send_family_message and db_read_latest_message.
#
# Wording rules: results are facts, never advice (a medication result says what was taken and
# what the label says, "in 24 hours", with days used in the last week); a result never names a
# caregiver no text was queued for (_told: "already told" only for the same event, and when
# nobody could be reached, "family could not be reached from here" with no reason); a distress
# flag always adds the emergency lines (config.py, US numbers); a report that may repeat a dose
# already written down asks whether it is the same one or another (log_dose another=true logs
# it); a dose can only be taken back in the conversation that logged it, and otherwise she is
# told earlier records cannot be changed here; an anytime task (scheduledTime ANYTIME) is
# "<label>, anytime today", never "due now" or "not due until". one_line and quoted keep
# family-written text to one line (a message body also in quotes).
#
# Last modified: 2026-11-09

from datetime import date, datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from config import CRISIS_LINE, EMERGENCY_NUMBER
from convex_client import ConvexClient

_DAY_ORDER = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
# What she is told when no caregiver could be texted: the fact, never the reason.
UNREACHABLE = "Family could not be reached from here; say exactly that, plainly."
# Added to every distress flag result, whatever happened to the flag.
EMERGENCY_LINES = (
    f" If they are hurt, fell, or are in danger, tell them to call {EMERGENCY_NUMBER}; if they "
    f"talk about hurting themselves, give {EMERGENCY_NUMBER} and {CRISIS_LINE}, the crisis line."
)
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
    label = r.get("displayLabel") or task_name
    if status == "confirmed":
        return f"Confirmed: {label} at {local_clock(r['confirmedAt'], tz)}."
    shared = _task_outcome(r, label, task_name, tz)
    if shared is not None:
        return shared
    if status == "nothing_due":
        return "Nothing is due right now."
    if status == "not_due_yet":
        return f"{label} is not ready to be marked done yet."
    if status == "ambiguous":
        options = "; ".join(describe_instance(o, tz) for o in r.get("options") or [])
        return f"Several tasks match: {options}. Ask which one they mean."
    return f"I don't see {task_name} on today's schedule."


def _task_outcome(r: dict[str, Any], label: str, task_name: str, tz: str) -> str | None:
    """
    purpose: The outcomes "Done" and "not yet" phrase the same way: already done, not due
             until a time (a timed task), and not on today's schedule.
    @param r: (dict) The agent:confirmDueTask or agent:snoozeDueTask result.
    @param label: (str) The task's display label (or the words said).
    @param task_name: (str) The words said.
    @param tz: (str) IANA timezone of the household.
    @return: (str | None) The sentence, or None for an outcome each tool phrases itself.
    """
    status = r.get("status")
    if status == "already_done":
        return f"Already done: {label} was confirmed at {local_clock(r['confirmedAt'], tz)}."
    if status == "not_due_yet" and r.get("scheduledTime") != ANYTIME:
        return f"{label} is not due until {format_time_for_voice(r['scheduledTime'])}."
    if status == "not_found":
        return f"I don't see {task_name} on today's schedule."
    return None


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
    today = to_local(now_epoch_ms(), tz).date()
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


def now_epoch_ms() -> float:
    """
    purpose: The current instant in epoch milliseconds (one place, so tests can fix it).
    @return: (float) Epoch ms.
    """
    return datetime.now(timezone.utc).timestamp() * 1000


def _dose_time(epoch_ms: float, now_ms: float, tz: str) -> str:
    """
    purpose: A dose time as spoken, marking one from the day before.
    @param epoch_ms: (float) The dose, epoch ms.
    @param now_ms: (float) Now, epoch ms.
    @param tz: (str) IANA timezone of the household.
    @return: (str) e.g. "11 AM" or "11 PM yesterday".
    """
    clock = local_clock(epoch_ms, tz)
    return clock if _same_local_day(epoch_ms, now_ms, tz) else f"{clock} yesterday"


def describe_as_needed(med: dict, tz: str, now_ms: float | None = None) -> str:
    """
    purpose: State the facts about one as-needed medication: label limits (the maximum is "in
             24 hours", the backend's stricter reading of "a day"), doses in the last 24 hours
             and, when now_ms is given, when another would be within the label and how many
             of the last 7 days it was used. Facts only; the decision stays with the senior.
    @param med: (dict) AsNeededEntry from agent:medicationStatus / getContext (camelCase).
    @param tz: (str) IANA timezone of the household.
    @param now_ms: (float | None) Epoch ms the facts are read at; None leaves out the
                   time-dependent sentences (the session-start context goes stale).
    @return: (str) e.g. "Pain reliever (small white): the label says up to 3 in 24 hours, at
             least 6 hours apart. Taken in the last 24 hours: 11 AM (1 of 3). Another would
             be within the label after 5 PM. Used on 2 of the last 7 days."
    """
    reference = now_ms if now_ms is not None else now_epoch_ms()
    label = one_line(med.get("displayLabel"))
    if med.get("pillDescription"):
        label += f" ({one_line(med['pillDescription'])})"
    limits = []
    max_per_day = med.get("maxPerDay")
    if max_per_day:
        limits.append(f"up to {max_per_day} in 24 hours")
    if med.get("minHoursBetween"):
        limits.append(f"at least {float(med['minHoursBetween']):g} hours apart")
    label_text = (
        f"the label says {', '.join(limits)}" if limits else "no limits are on file"
    )
    taken = [_dose_time(t, reference, tz) for t in med.get("takenLast24h") or []]
    taken_text = ", ".join(taken) if taken else "none"
    if max_per_day:
        taken_text += f" ({len(taken)} of {max_per_day})"
    text = f"{label}: {label_text}. Taken in the last 24 hours: {taken_text}."
    if now_ms is None:
        return text
    next_at = med.get("nextWithinLabelAt")
    if next_at is None:
        text += " Another would be within the label now."
    else:
        day = "" if _same_local_day(next_at, now_ms, tz) else " tomorrow"
        when = f"after {local_clock(next_at, tz)}{day}"
        if med.get("remainingToday") == 0:
            text += f" That is the most the label allows; the next would be {when}."
        else:
            text += f" Another would be within the label {when}."
    if med.get("daysUsedLast7"):
        text += f" Used on {med['daysUsedLast7']} of the last 7 days."
    return text


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
    shared = _task_outcome(r, label, task_name, tz)
    if shared is not None:
        return shared
    if status == "not_due_yet":
        return f"{label} can be done anytime today; there is no reminder to snooze."
    if status == "ambiguous":
        return f"Several tasks are due: {', '.join(r.get('options') or [])}. Ask which one."
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
    now_ms = now_epoch_ms()
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


# How db_log_dose's result starts when a dose report may repeat one already written down and
# the model must ask whether it is the same one or another. The result then holds the exact
# question after "Say exactly:", which speech_guard.py speaks if the model does not.
SAME_OR_ANOTHER = "Nothing new was logged yet"


async def db_log_dose(
    client: ConvexClient,
    household_id: str,
    tz: str,
    medication: str,
    minutes_ago: int,
    conversation_id: str | None,
    another: bool = False,
) -> str:
    """
    purpose: Log an as-needed dose the senior says they took through agent:logAsNeededDose,
             which also flags the caregiver when the dose goes past a label limit. Nothing is
             logged when no as-needed rule matches, or when the report may repeat a dose
             already written down (then the model asks whether it is the same one or another).
    @param client: (ConvexClient) Convex client.
    @param household_id: (str) Household id.
    @param tz: (str) IANA timezone of the household.
    @param medication: (str) Words naming the medication, or "" when only one is on file.
    @param minutes_ago: (int) Whole minutes since they took it (0 = just now).
    @param conversation_id: (str | None) The conversation, if one was opened.
    @param another: (bool) They said it is another dose, not the one already written down.
    @return: (str) Voice-friendly facts after the dose, or why nothing was logged.
    """
    r = (
        await client.mutation(
            "agent:logAsNeededDose",
            {
                "householdId": household_id,
                "label": medication or None,
                "minutesAgo": max(0, int(minutes_ago)),
                "another": another,
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
            "limits. Say what was taken today if asked, and offer to let family know or "
            "suggest asking the pharmacy."
        )
    if status == "not_found":
        return (
            f"Nothing was logged: no as-needed medication matches. On file: {options}."
        )
    if status == "ambiguous":
        return f"Nothing was logged yet: ask which one they took: {options}."
    if status == "scheduled_due":
        return (
            f"Nothing was logged: {options} is a scheduled medication that is due now. If "
            "that is what they took, use confirm_task."
        )
    med = r["medication"]
    label = one_line(med.get("displayLabel"))
    now_ms = now_epoch_ms()
    if status == "already_logged":
        if r.get("repeatCall"):
            return (
                f"Logged {label} at {local_clock(r['takenAt'], tz)}. "
                f"{describe_as_needed(med, tz, now_ms)}"
            )
        return (
            f'{SAME_OR_ANOTHER}. Say exactly: "I have one {label} written down at '
            f"{local_clock(r['takenAt'], tz)}. Is that the same one, or did you take "
            'another?" Do not say anything was logged and do not say they already told '
            "you. If they answer that it is another one, call log_dose again with another "
            "set to true."
        )
    text = (
        f"Logged {label} at {local_clock(r['takenAt'], tz)}. "
        f"{describe_as_needed(med, tz, now_ms)}"
    )
    breaches = []
    if r.get("overDailyMax"):
        breaches.append(f"{r.get('count')} in 24 hours, more than the label allows")
    if r.get("tooSoon"):
        hours = (
            f"{float(med['minHoursBetween']):g} " if med.get("minHoursBetween") else ""
        )
        breaches.append(f"sooner than the label's {hours}hours apart")
    if breaches:
        text += f" This dose is {' and '.join(breaches)}. " + _told(
            r.get("flagStatus"), r.get("flagged") or []
        )
    return text


def _told(status: str | None, names: list[str]) -> str:
    """
    purpose: Say who a flag reached, never naming anyone it did not reach.
    @param status: (str | None) flagged, already_flagged, unreachable or rate_limited.
    @param names: (list[str]) Caregivers a notification was queued for.
    @return: (str) One sentence for the model to pass on.
    """
    if status == "already_flagged" and names:
        return f"{join_names(names)} was already told about this a few minutes ago."
    if status == "flagged" and names:
        return f"{join_names(names)} has been told."
    if status == "rate_limited":
        return "No more messages can be sent to family right now; say so plainly."
    return UNREACHABLE


async def db_undo_last_dose(
    client: ConvexClient,
    household_id: str,
    tz: str,
    medication: str,
    conversation_id: str | None,
) -> str:
    """
    purpose: "No, I didn't take it": take back a dose they reported in this conversation in
             the last 30 minutes, through agent:undoLastDose; family is told if that dose had
             been reported to them. Any other dose cannot be changed here.
    @param client: (ConvexClient) Convex client.
    @param household_id: (str) Household id.
    @param tz: (str) IANA timezone of the household.
    @param medication: (str) Words naming the medication, or "" for the last one reported.
    @param conversation_id: (str | None) The conversation, if one was opened.
    @return: (str) What was removed, or why nothing was.
    """
    r = (
        await client.mutation(
            "agent:undoLastDose",
            {
                "householdId": household_id,
                "label": medication or None,
                "conversationId": conversation_id or None,
            },
        )
        or {}
    )
    status = r.get("status")
    if status == "removed":
        text = (
            f"Removed the {one_line(r.get('displayLabel'))} written down at "
            f"{local_clock(r['takenAt'], tz)}."
        )
        if r.get("corrected"):
            text += f" {join_names(r['corrected'])} has been told it was a mistake."
        return text
    if status == "ambiguous":
        return f"Ask which one to take back: {', '.join(r.get('options') or [])}."
    return (
        "Nothing was changed: only a dose written down in this conversation can be taken "
        "back. Say plainly that you cannot change earlier records, and offer to let family "
        "know."
    )


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
    purpose: Ask the on-call caregiver (or every reachable caregiver) to look in, through
             agent:flagCaregiver. Never names anyone a text was not queued for.
    @param client: (ConvexClient) Convex client.
    @param household_id: (str) Household id.
    @param reason: (str) symptom, money_request, scam, distress or help_requested.
    @param detail: (str) One or two sentences for the caregiver.
    @param conversation_id: (str | None) The conversation, if one was opened.
    @return: (str) Who was told, or that family could not be reached; a distress flag always
             adds the emergency lines.
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
    text = _told(r.get("status"), r.get("notified") or [])
    if reason == "distress":
        text += EMERGENCY_LINES
    return text


async def db_send_family_message(
    client: ConvexClient,
    household_id: str,
    to: str,
    message: str,
    conversation_id: str | None,
) -> str:
    """
    purpose: Send a message the senior dictated to family through agent:sendFamilyMessage
             (texted to caregivers by Sunny). Never names anyone a text was not queued for.
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
    status = r.get("status")
    if status == "already_sent":
        if r.get("earlierStatus") == "unreachable":
            return (
                "That same message was saved a moment ago, but family could not be reached "
                "from here; it was not sent again. Say exactly that, plainly."
            )
        return f"That same message went to {names} a moment ago; it was not sent again."
    if status == "sent_to_family":
        return f"{to} cannot get messages from Sunny, so the message went to {names}."
    if status == "rate_limited":
        return "No more messages can be sent right now; say so plainly."
    if status == "unreachable":
        return (
            "The message is saved, but family could not be reached from here; say exactly "
            "that, plainly."
        )
    return f"Sent to {names}."


def _spoken_when(epoch_ms: float, tz: str) -> str:
    """
    purpose: When something was sent, relative to today.
    @param epoch_ms: (float) Epoch ms.
    @param tz: (str) IANA timezone of the household.
    @return: (str) "today at 9 AM", "yesterday at 6 PM", or "on Monday, March 8".
    """
    moment = to_local(epoch_ms, tz)
    today = to_local(now_epoch_ms(), tz).date()
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
