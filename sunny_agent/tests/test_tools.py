# test_tools.py
# Purpose: Unit tests for the agent's task helpers (tools.py) and household context
# formatting (prompts.py). A small fake Convex client stands in for the HTTP API, so these
# run without a backend. Covers spoken time formatting, today's schedule descriptions,
# the context block, and how each agent:confirmDueTask / agent:cancelSeniorReminder outcome
# is phrased for voice (the selection rules themselves are tested in the Convex backend).
#
# Last modified: 2026-10-29

import pytest

from prompts import format_user_context
from tools import (
    db_cancel_senior_reminder,
    db_confirm_task,
    db_create_senior_reminder,
    db_list_today,
    describe_instance,
    format_time_for_voice,
)

TZ = "America/New_York"


class FakeConvex:
    """
    purpose: Stand-in for ConvexClient. Returns canned values per function path and
             records every call.
    """

    def __init__(self, responses: dict) -> None:
        """
        purpose: Store canned responses.
        @param responses: (dict) Convex function path -> value returned.
        """
        self.responses = responses
        self.calls: list[tuple[str, dict]] = []

    async def query(self, path: str, args: dict | None = None) -> object:
        """
        purpose: Record the query and return its canned value.
        @param path: (str) Function path.
        @param args: (dict | None) Function arguments.
        @return: Canned value.
        """
        self.calls.append((path, args or {}))
        return self.responses[path]

    async def mutation(self, path: str, args: dict | None = None) -> object:
        """
        purpose: Record the mutation and return its canned value.
        @param path: (str) Function path.
        @param args: (dict | None) Function arguments.
        @return: Canned value.
        """
        self.calls.append((path, args or {}))
        return self.responses[path]


def _context(*items: dict) -> dict:
    """
    purpose: Build an agent:getContext-shaped dict with the given instances for today.
    @param items: (dict) Instances for the 'today' list.
    @return: (dict) Context dict.
    """
    return {
        "household": {
            "seniorPreferredName": "Mom",
            "timezone": TZ,
            "localNow": "2027-03-13T08:20:00",
        },
        "today": list(items),
    }


MORNING_DUE = {
    "instanceId": "i-morning",
    "displayLabel": "Morning pills",
    "scheduledTime": "08:00",
    "state": "due",
    "confirmedAt": None,
}
MORNING_DONE = {
    **MORNING_DUE,
    "state": "confirmed",
    "confirmedAt": 1804943400000,
}
EVENING = {
    "instanceId": "i-evening",
    "displayLabel": "Evening pills",
    "scheduledTime": "20:00",
    "state": "upcoming",
    "confirmedAt": None,
}


def test_format_time_for_voice() -> None:
    """purpose: Spoken times cover on-the-hour, minutes, noon and midnight."""
    assert format_time_for_voice("08:00") == "8 AM"
    assert format_time_for_voice("20:30") == "8:30 PM"
    assert format_time_for_voice("12:00") == "noon"
    assert format_time_for_voice("00:00") == "midnight"


def test_describe_instance_states() -> None:
    """purpose: Each instance state reads naturally, with the local confirmation time."""
    assert describe_instance(MORNING_DONE, TZ) == "8 AM, Morning pills: done at 8:10 AM"
    assert describe_instance(MORNING_DUE, TZ) == "8 AM, Morning pills: due now"
    assert describe_instance(EVENING, TZ) == "8 PM, Evening pills: later today"
    assert (
        describe_instance({**MORNING_DUE, "state": "missed"}, TZ)
        == "8 AM, Morning pills: not done yet"
    )


def test_format_user_context_sections() -> None:
    """purpose: The context block includes schedule, meds, playbook and labeled memory."""
    ctx = _context(MORNING_DONE)
    ctx["asNeeded"] = [
        {
            "displayLabel": "Pain reliever",
            "maxPerDay": 3,
            "minHoursBetween": 6.0,
            "takenToday": [1804950000000],
        }
    ]
    ctx["sensitiveTopics"] = [
        {"topic": "her husband", "guidance": "Say he loved her very much."}
    ]
    ctx["memory"] = [
        {"fact": "Likes tea", "source": "caregiver", "verified": True},
        {"fact": "Has a cat", "source": "senior", "verified": False},
    ]
    block = format_user_context(ctx)
    assert "Local time now: Saturday, March 13, 8:20 AM" in block
    assert "8 AM, Morning pills: done at 8:10 AM" in block
    assert "up to 3 a day, at least 6 hours apart. Taken today: 10 AM." in block
    assert "If asked about her husband: Say he loved her very much." in block
    assert "Likes tea (verified)" in block
    assert "Has a cat (said by senior, unverified)" in block


def test_format_user_context_empty() -> None:
    """purpose: No household context produces a clear fallback line."""
    assert "No household context" in format_user_context({})


@pytest.mark.asyncio
async def test_confirm_task_sends_voice_and_no_label() -> None:
    """purpose: With no name, confirmDueTask is called as voice with a null label."""
    client = FakeConvex(
        {
            "agent:confirmDueTask": {
                "status": "confirmed",
                "displayLabel": "Morning pills",
                "confirmedAt": 1804943520000,
            }
        }
    )
    result = await db_confirm_task(client, "h1", TZ, "")  # type: ignore[arg-type]
    assert result == "Confirmed: Morning pills at 8:12 AM."
    assert client.calls == [
        (
            "agent:confirmDueTask",
            {"householdId": "h1", "label": None},
        )
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("response", "expected"),
    [
        (
            {
                "status": "already_done",
                "displayLabel": "Morning pills",
                "confirmedAt": 1804943400000,
            },
            "Already done: Morning pills was confirmed at 8:10 AM.",
        ),
        ({"status": "nothing_due"}, "Nothing is due right now."),
        (
            {
                "status": "not_due_yet",
                "displayLabel": "Evening pills",
                "scheduledTime": "20:00",
            },
            "Evening pills is not due until 8 PM.",
        ),
        (
            {"status": "ambiguous", "options": [MORNING_DUE, EVENING]},
            "Several tasks match: 8 AM, Morning pills: due now; "
            "8 PM, Evening pills: later today. Ask which one they mean.",
        ),
        ({"status": "not_found"}, "I don't see pills on today's schedule."),
    ],
)
async def test_confirm_task_phrases_each_outcome(response: dict, expected: str) -> None:
    """purpose: Every confirmDueTask status is phrased for voice."""
    client = FakeConvex({"agent:confirmDueTask": response})
    assert await db_confirm_task(client, "h1", TZ, "pills") == expected  # type: ignore[arg-type]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("response", "expected"),
    [
        (
            {"status": "cancelled", "titles": ["call the plumber"]},
            "Cancelled the reminder to call the plumber.",
        ),
        (
            {"status": "ambiguous", "titles": ["call the plumber", "water the plants"]},
            "Several reminders match: call the plumber, water the plants. "
            "Ask which one to cancel.",
        ),
        (
            {"status": "not_found", "titles": []},
            "No reminder they created matches 'pills'. Reminders set up by family "
            "can only be changed by family.",
        ),
    ],
)
async def test_cancel_reminder_phrases_each_outcome(
    response: dict, expected: str
) -> None:
    """purpose: Every cancelSeniorReminder status is phrased for voice."""
    client = FakeConvex({"agent:cancelSeniorReminder": response})
    assert await db_cancel_senior_reminder(client, "h1", "pills") == expected  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_list_today_describes_schedule() -> None:
    """purpose: db_list_today queries agent:today and joins the entries."""
    client = FakeConvex({"agent:today": [MORNING_DONE, EVENING]})
    result = await db_list_today(client, "h1", TZ)  # type: ignore[arg-type]
    assert result == (
        "Today: 8 AM, Morning pills: done at 8:10 AM; 8 PM, Evening pills: later today."
    )
    assert client.calls == [("agent:today", {"householdId": "h1"})]


@pytest.mark.asyncio
async def test_list_today_empty() -> None:
    """purpose: An empty schedule gets the nothing-scheduled sentence."""
    client = FakeConvex({"agent:today": []})
    result = await db_list_today(client, "h1", TZ)  # type: ignore[arg-type]
    assert result == "There is nothing on the schedule for today."


@pytest.mark.asyncio
async def test_create_reminder_recurring_sends_iso_weekdays() -> None:
    """purpose: Recurring reminders map day names to ISO numbers (Mon=1..Sun=7)."""
    client = FakeConvex({"agent:createSeniorReminder": {"taskId": "t1"}})
    result = await db_create_senior_reminder(
        client,  # type: ignore[arg-type]
        "h1",
        TZ,
        "call the plumber",
        "10:00",
        "",
        ["mon", "sun"],
    )
    assert result == "Done. I'll remind you to call the plumber at 10 AM on Mon, Sun."
    assert client.calls == [
        (
            "agent:createSeniorReminder",
            {
                "householdId": "h1",
                "title": "call the plumber",
                "time": "10:00",
                "onDate": None,
                "days": [1, 7],
            },
        )
    ]


@pytest.mark.asyncio
async def test_create_reminder_one_off_sends_date_and_no_days() -> None:
    """purpose: One-off reminders send onDate and null days."""
    client = FakeConvex({"agent:createSeniorReminder": {"taskId": "t1"}})
    await db_create_senior_reminder(
        client,  # type: ignore[arg-type]
        "h1",
        TZ,
        "call the plumber",
        "10:00",
        "2099-01-05",
    )
    assert client.calls[0][1]["onDate"] == "2099-01-05"
    assert client.calls[0][1]["days"] is None


@pytest.mark.asyncio
async def test_cancel_reminder_sends_query() -> None:
    """purpose: cancelSeniorReminder receives the household and the title query."""
    client = FakeConvex(
        {"agent:cancelSeniorReminder": {"status": "cancelled", "titles": ["x"]}}
    )
    await db_cancel_senior_reminder(client, "h1", "pills")  # type: ignore[arg-type]
    assert client.calls == [
        ("agent:cancelSeniorReminder", {"householdId": "h1", "query": "pills"})
    ]


def test_format_user_context_events_and_conversations() -> None:
    """purpose: Epoch-ms event starts and conversation dates render in household time."""
    ctx = _context(MORNING_DUE)
    ctx["events"] = [
        {
            "title": "Dentist",
            "startsAt": 1804946400000,
            "visitorName": "Sarah",
            "place": "Main St",
        }
    ]
    ctx["latestMessage"] = {"from": "Sarah", "body": "Hi Mom", "hasPhoto": False}
    ctx["recentConversations"] = [
        {"startedAt": 1804943400000, "summary": "Asked time."}
    ]
    block = format_user_context(ctx)
    assert "Saturday, March 13, 9 AM: Dentist, with Sarah, at Main St" in block
    assert "Latest family message, from Sarah: Hi Mom" in block
    assert "2027-03-13: Asked time." in block
