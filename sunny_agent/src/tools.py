# tools.py
# Purpose: Pure async database helper functions for Sunny reminder CRUD operations.
# Provides time/day formatting utilities for voice-friendly output, and async
# functions that read from and write to the Supabase `reminders` table.
# These helpers contain no LiveKit imports or @function_tool decorators; they are
# called by the @function_tool methods on the Assistant class in agent.py.
#
# Last modified: 2026-02-22

from supabase import AsyncClient


def format_time_for_voice(t: str) -> str:
    """
    purpose: Convert a 24-hour time string to a voice-friendly spoken form.
    @param t: (str) Time in "HH:MM" 24-hour format.
    @return: (str) Spoken time, e.g. "9 AM", "9:30 PM", "noon", "midnight".
    """
    parts = t.split(":")
    if len(parts) != 2:
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
    ALL_DAYS = {"mon", "tue", "wed", "thu", "fri", "sat", "sun"}
    WEEKDAYS = {"mon", "tue", "wed", "thu", "fri"}
    WEEKEND = {"sat", "sun"}
    DAY_LABELS = {
        "mon": "Mon", "tue": "Tue", "wed": "Wed",
        "thu": "Thu", "fri": "Fri", "sat": "Sat", "sun": "Sun",
    }

    day_set = {d.lower() for d in days}

    if day_set == ALL_DAYS:
        return "every day"
    if day_set == WEEKDAYS:
        return "on weekdays"
    if day_set == WEEKEND:
        return "on weekends"

    ordered = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
    labels = [DAY_LABELS[d] for d in ordered if d in day_set]
    return "on " + ", ".join(labels)


async def db_save_reminder(
    client: AsyncClient,
    user_id: str,
    type: str,
    title: str,
    description: str,
    times: list[str],
    days: list[str],
) -> str:
    """
    purpose: Insert a new reminder into the Supabase reminders table and return
             a voice-friendly confirmation string.
    @param client: (AsyncClient) Supabase async client.
    @param user_id: (str) UUID of the user who owns this reminder.
    @param type: (str) Reminder type: 'medication'|'appointment'|'exercise'|'wellness_checkin'|'custom'.
    @param title: (str) Short label for the reminder, e.g. "blood pressure medication".
    @param description: (str) Optional additional detail (may be empty string).
    @param times: (list[str]) 24-hour time strings, e.g. ["09:00", "21:00"].
    @param days: (list[str]) Day abbreviations, e.g. ["mon","tue","wed","thu","fri","sat","sun"].
    @return: (str) Voice-friendly confirmation, e.g. "Done, I've saved your aspirin reminder...".
    """
    await client.table("reminders").insert({
        "user_id": user_id,
        "type": type,
        "title": title,
        "description": description,
        "schedule": {"times": times, "days": days},
        "timezone": "America/New_York",
    }).execute()

    time_str = " and ".join(format_time_for_voice(t) for t in times)
    days_str = format_days_for_voice(days)
    return f"Done, I've saved your {title} reminder for {time_str} {days_str}."


async def db_list_reminders(client: AsyncClient, user_id: str) -> str:
    """
    purpose: Query all active reminders for a user and return a voice-friendly summary.
    @param client: (AsyncClient) Supabase async client.
    @param user_id: (str) UUID of the user whose reminders to fetch.
    @return: (str) Voice-friendly listing of active reminders, or a message indicating
             none exist.
    """
    result = (
        await client.table("reminders")
        .select("*")
        .eq("user_id", user_id)
        .eq("active", True)
        .execute()
    )
    rows = result.data

    if not rows:
        return "You don't have any active reminders set up yet."

    parts = []
    for r in rows:
        title = r.get("title", "")
        schedule = r.get("schedule", {})
        times = schedule.get("times", [])
        days = schedule.get("days", [])

        entry = title
        if times:
            entry += " at " + " and ".join(format_time_for_voice(t) for t in times)
        if days:
            entry += " " + format_days_for_voice(days)
        parts.append(entry)

    count = len(parts)
    if count == 1:
        return f"You have 1 reminder: {parts[0]}."

    joined = ", ".join(parts[:-1]) + f", and {parts[-1]}"
    return f"You have {count} reminders: {joined}."


async def db_delete_reminder(
    client: AsyncClient, user_id: str, title_query: str
) -> tuple[str, list[dict]]:
    """
    purpose: Soft-delete a reminder via case-insensitive title substring match.
             Sets active=false on the matched row rather than removing it.
    @param client: (AsyncClient) Supabase async client.
    @param user_id: (str) UUID of the user whose reminders to search.
    @param title_query: (str) The name or partial name to match against reminder titles.
    @return: (tuple[str, list[dict]]) A (status, matches) pair where status is one of:
             "not_found" — no active reminders matched the query,
             "deleted"   — exactly one matched and was soft-deleted (active=false),
             "ambiguous" — multiple matched, caller must ask user to clarify.
             matches contains the matched reminder rows.
    """
    result = (
        await client.table("reminders")
        .select("*")
        .eq("user_id", user_id)
        .eq("active", True)
        .ilike("title", f"%{title_query}%")
        .execute()
    )
    matches = result.data

    if not matches:
        return "not_found", []

    if len(matches) > 1:
        return "ambiguous", matches

    reminder_id = matches[0]["id"]
    await client.table("reminders").update({"active": False}).eq("id", reminder_id).execute()
    return "deleted", matches
