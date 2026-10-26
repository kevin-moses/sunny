# tools.py
# Purpose: Async helpers behind the agent's task tools, plus voice-friendly time and date
# formatting shared with prompts.py. Every decision lives in the database RPCs the other
# surfaces also use: get_today (today's schedule), confirm_due_task (which task "Done"
# means and the already-done guard), create_senior_reminder and cancel_senior_reminder
# (senior-created reminders only). These helpers only call the RPC and phrase the result
# for voice. They contain no LiveKit imports; the @function_tool methods on Assistant in
# agent.py call them.
#
# Memory-care pivot (2026-10-25): replaced reminders-table CRUD with household task RPCs.
#
# Last modified: 2026-10-25

from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from supabase import AsyncClient

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


def to_local(iso_timestamp: str, tz: str) -> datetime:
    """
    purpose: Convert an ISO timestamp from Postgres to the household's local time.
    @param iso_timestamp: (str) ISO 8601 timestamp with offset.
    @param tz: (str) IANA timezone of the household.
    @return: (datetime) Aware datetime in the household timezone.
    """
    return datetime.fromisoformat(iso_timestamp).astimezone(ZoneInfo(tz))


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


def local_clock(iso_timestamp: str, tz: str) -> str:
    """
    purpose: Spoken local time of an ISO timestamp in the household timezone.
    @param iso_timestamp: (str) ISO 8601 timestamp with offset.
    @param tz: (str) IANA timezone of the household.
    @return: (str) e.g. "8:10 AM".
    """
    return clock_for_voice(to_local(iso_timestamp, tz))


def describe_instance(item: dict, tz: str) -> str:
    """
    purpose: Describe one of today's task instances for voice.
    @param item: (dict) Entry from get_today / get_agent_context()['today'].
    @param tz: (str) IANA timezone of the household.
    @return: (str) e.g. "8 AM, Morning pills: done at 8:10 AM".
    """
    label = item.get("display_label", "")
    when = format_time_for_voice(item.get("scheduled_time", ""))
    state = item.get("state", "")
    if state in _DONE_STATES and item.get("confirmed_at"):
        status = f"done at {local_clock(item['confirmed_at'], tz)}"
    elif state in ("due", "escalated"):
        status = "due now"
    elif state == "missed":
        status = "not done yet"
    else:
        status = "later today"
    return f"{when}, {label}: {status}"


async def db_list_today(client: AsyncClient, household_id: str, tz: str) -> str:
    """
    purpose: Describe today's schedule and what has been done, for voice.
    @param client: (AsyncClient) Supabase async client (service role).
    @param household_id: (str) Household UUID.
    @param tz: (str) IANA timezone of the household.
    @return: (str) Voice-friendly listing of today's tasks, or a message if there are none.
    """
    result = await client.rpc("get_today", {"p_household_id": household_id}).execute()
    items = result.data or []
    if not items:
        return "There is nothing on the schedule for today."
    return "Today: " + "; ".join(describe_instance(i, tz) for i in items) + "."


async def db_confirm_task(
    client: AsyncClient, household_id: str, tz: str, task_name: str
) -> str:
    """
    purpose: Confirm one of today's tasks by voice through confirm_due_task, which picks
             the task (the due one when no name is given) and guards against confirming
             twice. Phrases each outcome for the agent.
    @param client: (AsyncClient) Supabase async client (service role).
    @param household_id: (str) Household UUID.
    @param tz: (str) IANA timezone of the household.
    @param task_name: (str) Name or part of the task's label, or "" for whatever is due.
    @return: (str) Voice-friendly outcome: confirmed, already done, nothing due, not
             found, not due yet, or a clarifying question.
    """
    result = await client.rpc(
        "confirm_due_task",
        {
            "p_household_id": household_id,
            "p_via": "voice",
            "p_label": task_name or None,
        },
    ).execute()
    r = result.data or {}
    status = r.get("status")
    label = r.get("display_label", task_name)
    if status == "confirmed":
        return f"Confirmed: {label} at {local_clock(r['confirmed_at'], tz)}."
    if status == "already_done":
        return f"Already done: {label} was confirmed at {local_clock(r['confirmed_at'], tz)}."
    if status == "nothing_due":
        return "Nothing is due right now."
    if status == "not_due_yet":
        return f"{label} is not due until {format_time_for_voice(r['scheduled_time'])}."
    if status == "ambiguous":
        options = "; ".join(describe_instance(o, tz) for o in r.get("options", []))
        return f"Several tasks match: {options}. Ask which one they mean."
    return f"I don't see {task_name} on today's schedule."


async def db_create_senior_reminder(
    client: AsyncClient,
    household_id: str,
    tz: str,
    title: str,
    time: str,
    on_date: str = "",
    days: list[str] | None = None,
) -> str:
    """
    purpose: Create a reminder the senior asked for through create_senior_reminder, which
             sets the senior-created defaults (prompt-only policy, wording, window).
             One-off when on_date is given, otherwise recurring on days (every day if empty).
    @param client: (AsyncClient) Supabase async client (service role).
    @param household_id: (str) Household UUID.
    @param tz: (str) IANA timezone of the household, used to phrase the date.
    @param title: (str) What to remind them about, e.g. "call the plumber".
    @param time: (str) 24-hour "HH:MM".
    @param on_date: (str) "YYYY-MM-DD" for a one-off reminder, or "".
    @param days: (list[str] | None) Day abbreviations for a recurring reminder.
    @return: (str) Voice-friendly confirmation.
    """
    day_list = [d.lower() for d in (days or []) if d.lower() in _DAY_ORDER]
    await client.rpc(
        "create_senior_reminder",
        {
            "p_household_id": household_id,
            "p_title": title,
            "p_time": time,
            "p_on_date": on_date or None,
            "p_days": [_DAY_ORDER.index(d) + 1 for d in day_list] or None,
        },
    ).execute()

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
    client: AsyncClient, household_id: str, title_query: str
) -> str:
    """
    purpose: Cancel a reminder the senior created through cancel_senior_reminder.
             Caregiver-created tasks are never matched.
    @param client: (AsyncClient) Supabase async client (service role).
    @param household_id: (str) Household UUID.
    @param title_query: (str) Name or part of the reminder's title.
    @return: (str) Voice-friendly outcome: cancelled, not found, or a clarifying question.
    """
    result = await client.rpc(
        "cancel_senior_reminder",
        {"p_household_id": household_id, "p_query": title_query},
    ).execute()
    r = result.data or {}
    titles = r.get("titles", [])
    if r.get("status") == "cancelled":
        return f"Cancelled the reminder to {titles[0]}."
    if r.get("status") == "ambiguous":
        return f"Several reminders match: {', '.join(titles)}. Ask which one to cancel."
    return (
        f"No reminder they created matches '{title_query}'. Reminders set up by "
        "family can only be changed by family."
    )
