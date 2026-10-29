# test_tools.py
# Purpose: Unit tests for the agent's task helpers (tools.py) and household context
# formatting (prompts.py). A small fake Supabase client stands in for the RPCs, so these
# run without a database. Covers spoken time formatting, today's schedule descriptions,
# the context block, and how each confirm_due_task / cancel_senior_reminder outcome
# is phrased for voice (the selection rules themselves are tested in pgTAP).
#
# Last modified: 2026-10-25

from types import SimpleNamespace

import pytest

from prompts import format_user_context
from tools import (
    db_cancel_senior_reminder,
    db_confirm_task,
    describe_instance,
    format_time_for_voice,
)

TZ = "America/New_York"


class FakeRpc:
    """
    purpose: Minimal stand-in for supabase-py's rpc(...).execute() chain. Returns canned
             data per RPC name and records every call.
    """

    def __init__(self, responses: dict) -> None:
        """
        purpose: Store canned responses.
        @param responses: (dict) RPC name -> data returned by execute().
        """
        self.responses = responses
        self.calls: list[tuple[str, dict]] = []

    def rpc(self, name: str, params: dict) -> SimpleNamespace:
        """
        purpose: Record the call and return an object whose async execute() yields the data.
        @param name: (str) RPC name.
        @param params: (dict) RPC parameters.
        @return: (SimpleNamespace) Object with an async execute() method.
        """
        self.calls.append((name, params))

        async def execute() -> SimpleNamespace:
            """
            purpose: Return the canned response for this RPC.
            @return: (SimpleNamespace) Object with .data.
            """
            return SimpleNamespace(data=self.responses[name])

        return SimpleNamespace(execute=execute)


def _context(*items: dict) -> dict:
    """
    purpose: Build a get_agent_context-shaped dict with the given instances for today.
    @param items: (dict) Instances for the 'today' list.
    @return: (dict) Context dict.
    """
    return {
        "household": {
            "senior_preferred_name": "Mom",
            "timezone": TZ,
            "local_now": "2027-03-13T08:20:00",
        },
        "today": list(items),
    }


MORNING_DUE = {
    "instance_id": "i-morning",
    "display_label": "Morning pills",
    "scheduled_time": "08:00:00",
    "state": "due",
    "confirmed_at": None,
}
MORNING_DONE = {
    **MORNING_DUE,
    "state": "confirmed",
    "confirmed_at": "2027-03-13T13:10:00+00:00",
}
EVENING = {
    "instance_id": "i-evening",
    "display_label": "Evening pills",
    "scheduled_time": "20:00:00",
    "state": "upcoming",
    "confirmed_at": None,
}


def test_format_time_for_voice() -> None:
    """purpose: Spoken times cover on-the-hour, minutes, noon and midnight."""
    assert format_time_for_voice("08:00:00") == "8 AM"
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
    ctx["as_needed"] = [
        {
            "display_label": "Pain reliever",
            "max_per_day": 3,
            "min_hours_between": 6.0,
            "taken_today": ["2027-03-13T15:00:00+00:00"],
        }
    ]
    ctx["sensitive_topics"] = [
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
    """purpose: With no name, confirm_due_task is called as voice with a null label."""
    client = FakeRpc(
        {
            "confirm_due_task": {
                "status": "confirmed",
                "display_label": "Morning pills",
                "confirmed_at": "2027-03-13T13:12:00+00:00",
            }
        }
    )
    result = await db_confirm_task(client, "h1", TZ, "")  # type: ignore[arg-type]
    assert result == "Confirmed: Morning pills at 8:12 AM."
    assert client.calls == [
        (
            "confirm_due_task",
            {"p_household_id": "h1", "p_via": "voice", "p_label": None},
        )
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("response", "expected"),
    [
        (
            {
                "status": "already_done",
                "display_label": "Morning pills",
                "confirmed_at": "2027-03-13T13:10:00+00:00",
            },
            "Already done: Morning pills was confirmed at 8:10 AM.",
        ),
        ({"status": "nothing_due"}, "Nothing is due right now."),
        (
            {
                "status": "not_due_yet",
                "display_label": "Evening pills",
                "scheduled_time": "20:00:00",
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
    """purpose: Every confirm_due_task status is phrased for voice."""
    client = FakeRpc({"confirm_due_task": response})
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
    """purpose: Every cancel_senior_reminder status is phrased for voice."""
    client = FakeRpc({"cancel_senior_reminder": response})
    assert await db_cancel_senior_reminder(client, "h1", "pills") == expected  # type: ignore[arg-type]
