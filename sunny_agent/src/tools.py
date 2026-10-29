# tools.py
# Purpose: Async helpers behind the agent's task tools, plus voice-friendly time and date
# formatting shared with prompts.py. Every decision lives in the Convex agent:* functions the
# other surfaces also use: agent:today (today's schedule), agent:confirmDueTask (which task
# "Done" means and the already-done guard), agent:createSeniorReminder and
# agent:cancelSeniorReminder (senior-created reminders only). These helpers only call the
# function and phrase the result for voice. Instants arrive as epoch milliseconds. They contain no LiveKit imports; the @function_tool methods on Assistant in
# agent.py call them.
#
# Memory-care pivot (2026-10-25): replaced reminders-table CRUD with household task RPCs.
# Convex migration (2026-10-29): RPCs became Convex calls; timestamps are epoch ms.
#
# Last modified: 2026-10-29

from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from convex_client import ConvexClient

_DAY_ORDER = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
_DONE_STATES = {"confirmed", "resolved"}


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
    @return: (str) e.g. "8 AM, Morning pills: done at 8:10 AM".
    """
    label = item.get("displayLabel", "")
    when = format_time_for_voice(item.get("scheduledTime", ""))
    state = item.get("state", "")
    if state in _DONE_STATES and item.get("confirmedAt"):
        status = f"done at {local_clock(item['confirmedAt'], tz)}"
    elif state in ("due", "escalated"):
        status = "due now"
    elif state == "missed":
        status = "not done yet"
    else:
        status = "later today"
    return f"{when}, {label}: {status}"


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
