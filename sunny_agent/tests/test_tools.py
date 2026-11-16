from pathlib import Path

import pytest

from convex_client import ConvexArgs
from convex_types import AgentContext, TodayEntry
from prompts import format_user_context
from tools import (
    ANYTIME,
    StepsRead,
    db_cancel_senior_reminder,
    db_confirm_task,
    db_create_senior_reminder,
    db_list_today,
    describe_instance,
    format_time_for_voice,
)

TZ = "America/New_York"
BACKEND_ANYTIME_SOURCE = (
    Path(__file__).resolve().parents[2]
    / "sunny_backend"
    / "convex"
    / "lib"
    / "anytime.ts"
)


def test_anytime_matches_the_backend_constant() -> None:
    assert f'export const ANYTIME = "{ANYTIME}";' in BACKEND_ANYTIME_SOURCE.read_text()


class FakeConvex:
    def __init__(self, responses: dict[str, object]) -> None:
        self.responses = responses
        self.calls: list[tuple[str, ConvexArgs]] = []

    async def query(self, path: str, args: ConvexArgs) -> object:
        self.calls.append((path, args))
        return self.responses[path]

    async def mutation(self, path: str, args: ConvexArgs) -> object:
        self.calls.append((path, args))
        return self.responses[path]


def empty_context(
    name: str = "Mom", local_now: str = "2027-03-13T08:20:00"
) -> AgentContext:
    return {
        "household": {
            "seniorPreferredName": name,
            "timezone": TZ,
            "localNow": local_now,
            "weatherLocation": None,
        },
        "caregivers": [],
        "today": [],
        "asNeeded": [],
        "events": [],
        "latestMessage": None,
        "lifeProfile": [],
        "sensitiveTopics": [],
        "memory": [],
        "recentConversations": [],
        "recentQuestionTopics": [],
        "list": {"openCount": 0, "items": []},
    }


def today_entry(instance_id: str, label: str) -> TodayEntry:
    return {
        "instanceId": instance_id,
        "type": "medication",
        "displayLabel": label,
        "spokenPrompt": f"Time for {label}.",
        "pillDescription": None,
        "checklistItems": [],
        "step": None,
        "scheduledTime": "08:00",
        "state": "upcoming",
        "confirmedAt": None,
    }


def context_with(*items: TodayEntry) -> AgentContext:
    return {**empty_context(), "today": list(items)}


MORNING_DUE: TodayEntry = {
    **today_entry("i-morning", "Morning pills"),
    "state": "due",
}
MORNING_DONE: TodayEntry = {
    **MORNING_DUE,
    "state": "confirmed",
    "confirmedAt": 1804943400000,
}
EVENING: TodayEntry = {
    **today_entry("i-evening", "Evening pills"),
    "scheduledTime": "20:00",
}


def test_format_time_for_voice() -> None:
    assert format_time_for_voice("08:00") == "8 AM"
    assert format_time_for_voice("20:30") == "8:30 PM"
    assert format_time_for_voice("12:00") == "noon"
    assert format_time_for_voice("00:00") == "midnight"


def test_describe_instance_anytime() -> None:
    water: TodayEntry = {
        **MORNING_DUE,
        "displayLabel": "Water plants",
        "scheduledTime": "anytime",
    }
    for state in ("upcoming", "due", "escalated"):
        text = describe_instance({**water, "state": state}, TZ)
        assert text == "Water plants, anytime today: still to do today"
    done: TodayEntry = {
        **water,
        "state": "confirmed",
        "confirmedAt": MORNING_DONE["confirmedAt"],
    }
    assert describe_instance(done, TZ) == "Water plants, anytime today: done at 8:10 AM"
    assert (
        describe_instance({**water, "state": "missed"}, TZ)
        == "Water plants, anytime today: not done yet"
    )


GOING_OUT: TodayEntry = {
    **today_entry("i-out", "Going out"),
    "type": "checklist",
    "state": "due",
    "checklistItems": ["Put on your coat", "Take your keys", "Lock the door"],
    "step": {"index": 1, "count": 3, "text": "Take your keys"},
}


def test_describe_instance_names_the_current_step_until_done() -> None:
    assert describe_instance(GOING_OUT, TZ) == (
        "8 AM, Going out: due now, on step 2 of 3: Take your keys"
    )
    done: TodayEntry = {**GOING_OUT, "state": "confirmed", "confirmedAt": 1804943400000}
    assert describe_instance(done, TZ) == "8 AM, Going out: done at 8:10 AM"


@pytest.mark.asyncio
async def test_list_today_describes_the_current_step() -> None:
    client = FakeConvex({"agent:today": [GOING_OUT]})
    assert await db_list_today(client, "h1", TZ) == (
        "Today: 8 AM, Going out: due now, on step 2 of 3: Take your keys."
    )


@pytest.mark.asyncio
async def test_confirm_task_on_a_step_reads_the_next_step() -> None:
    client = FakeConvex(
        {
            "agent:confirmDueTask": {
                "status": "advanced",
                "displayLabel": "Going out",
                "step": {"index": 2, "count": 3, "text": "Lock the door"},
            }
        }
    )
    assert await db_confirm_task(client, "h1", TZ, "") == (
        "Step 2 of 3 of Going out is done; the task is not done until the last step. "
        "Next: Step 3 of 3: Lock the door. Read that step to them."
    )


def test_describe_instance_states() -> None:
    assert describe_instance(MORNING_DONE, TZ) == "8 AM, Morning pills: done at 8:10 AM"
    assert describe_instance(MORNING_DUE, TZ) == "8 AM, Morning pills: due now"
    assert describe_instance(EVENING, TZ) == "8 PM, Evening pills: later today"
    assert (
        describe_instance({**MORNING_DUE, "state": "missed"}, TZ)
        == "8 AM, Morning pills: not done yet"
    )


def test_format_user_context_sections() -> None:
    ctx = context_with(MORNING_DONE)
    ctx["asNeeded"] = [
        {
            "displayLabel": "Pain reliever",
            "pillDescription": None,
            "maxPerDay": 3,
            "minHoursBetween": 6.0,
            "takenToday": [1804950000000],
            "takenLast24h": [1804950000000],
            "remainingToday": 2,
            "nextWithinLabelAt": None,
            "daysUsedLast7": 1,
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
    assert (
        "Pain reliever: the label says up to 3 in 24 hours, at least 6 hours apart. "
        "Taken in the last 24 hours: 10 AM" in block
    )
    assert "within the label" not in block
    assert "If asked about her husband: Say he loved her very much." in block
    assert '  - [verified by family] "Likes tea"' in block
    assert '  - [said by Mom, not verified] "Has a cat"' in block
    assert "Weather location: not set by family." in block


def test_format_user_context_caregivers_and_weather() -> None:
    ctx = context_with()
    ctx["household"]["weatherLocation"] = "Brooklyn, NY"
    ctx["caregivers"] = [{"name": "Anna"}, {"name": "Bob"}]
    block = format_user_context(ctx)
    assert "Weather location: Brooklyn, NY" in block
    assert "Family caregivers in Sunny: Anna, Bob" in block
    assert "on call" not in block


def test_format_user_context_empty() -> None:
    assert "No household information" in format_user_context(None)


@pytest.mark.asyncio
async def test_confirm_task_sends_voice_and_no_label() -> None:
    client = FakeConvex(
        {
            "agent:confirmDueTask": {
                "status": "confirmed",
                "displayLabel": "Morning pills",
                "confirmedAt": 1804943520000,
            }
        }
    )
    result = await db_confirm_task(client, "h1", TZ, "")
    assert result == "Confirmed: Morning pills at 8:12 AM."
    assert client.calls == [
        (
            "agent:confirmDueTask",
            {"householdId": "h1", "label": None, "step": None},
        )
    ]


KEYS = {"index": 1, "count": 3, "text": "Take your keys"}
DOOR = {"index": 2, "count": 3, "text": "Lock the door"}


def _steps_read_on(index: int) -> StepsRead:
    steps = StepsRead()
    steps.note("Going out", {"index": index, "count": 3, "text": "Put on your coat"})
    return steps


@pytest.mark.asyncio
async def test_confirm_task_sends_the_step_the_session_read_and_follows_it() -> None:
    steps = _steps_read_on(0)
    client = FakeConvex(
        {
            "agent:confirmDueTask": {
                "status": "advanced",
                "displayLabel": "Going out",
                "step": KEYS,
            }
        }
    )
    await db_confirm_task(client, "h1", TZ, "going out", steps)
    client.responses["agent:confirmDueTask"] = {
        "status": "advanced",
        "displayLabel": "Going out",
        "step": DOOR,
    }
    await db_confirm_task(client, "h1", TZ, "going out", steps)
    client.responses["agent:confirmDueTask"] = {
        "status": "confirmed",
        "displayLabel": "Going out",
        "confirmedAt": 1804943520000,
    }
    await db_confirm_task(client, "h1", TZ, "going out", steps)
    await db_confirm_task(client, "h1", TZ, "going out", steps)
    assert [call[1]["step"] for call in client.calls] == [0, 1, 2, None]


@pytest.mark.asyncio
async def test_confirm_task_sends_no_step_for_a_task_the_session_did_not_read() -> None:
    client = FakeConvex({"agent:confirmDueTask": {"status": "nothing_due"}})
    await db_confirm_task(client, "h1", TZ, "", _steps_read_on(0))
    await db_confirm_task(client, "h1", TZ, "pills", _steps_read_on(0))
    await db_confirm_task(client, "h1", TZ, "going out", None)
    assert [call[1]["step"] for call in client.calls] == [None, None, None]


def test_steps_read_needs_one_match() -> None:
    steps = _steps_read_on(1)
    steps.note("Going to bed", {"index": 0, "count": 2, "text": "Brush teeth"})
    assert steps.step_for("going out") == 1
    assert steps.step_for("going") is None
    steps.note("Going out", None)
    assert steps.step_for("going") == 0


@pytest.mark.asyncio
async def test_confirm_task_on_another_step_marks_nothing_and_reads_the_current_one() -> (
    None
):
    steps = _steps_read_on(0)
    client = FakeConvex(
        {
            "agent:confirmDueTask": {
                "status": "other_step",
                "displayLabel": "Going out",
                "step": KEYS,
            }
        }
    )
    assert await db_confirm_task(client, "h1", TZ, "going out", steps) == (
        "Nothing was marked done: Going out is on another step than the one read out. "
        "It is on Step 2 of 3: Take your keys. Read that step to them."
    )
    assert steps.step_for("going out") == 1


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
    client = FakeConvex({"agent:confirmDueTask": response})
    assert await db_confirm_task(client, "h1", TZ, "pills") == expected


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
    client = FakeConvex({"agent:cancelSeniorReminder": response})
    assert await db_cancel_senior_reminder(client, "h1", "pills") == expected


@pytest.mark.asyncio
async def test_list_today_describes_schedule() -> None:
    client = FakeConvex({"agent:today": [MORNING_DONE, EVENING]})
    result = await db_list_today(client, "h1", TZ)
    assert result == (
        "Today: 8 AM, Morning pills: done at 8:10 AM; 8 PM, Evening pills: later today."
    )
    assert client.calls == [("agent:today", {"householdId": "h1"})]


@pytest.mark.asyncio
async def test_list_today_empty() -> None:
    client = FakeConvex({"agent:today": []})
    result = await db_list_today(client, "h1", TZ)
    assert result == "There is nothing on the schedule for today."


@pytest.mark.asyncio
async def test_create_reminder_recurring_sends_iso_weekdays() -> None:
    client = FakeConvex({"agent:createSeniorReminder": {"taskId": "t1"}})
    result = await db_create_senior_reminder(
        client,
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
    client = FakeConvex({"agent:createSeniorReminder": {"taskId": "t1"}})
    await db_create_senior_reminder(
        client,
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
    client = FakeConvex(
        {"agent:cancelSeniorReminder": {"status": "cancelled", "titles": ["x"]}}
    )
    await db_cancel_senior_reminder(client, "h1", "pills")
    assert client.calls == [
        ("agent:cancelSeniorReminder", {"householdId": "h1", "query": "pills"})
    ]


def test_format_user_context_events_and_conversations() -> None:
    ctx = context_with(MORNING_DUE)
    ctx["events"] = [
        {
            "title": "Dentist",
            "startsAt": 1804946400000,
            "visitorName": "Sarah",
            "place": "Main St",
        }
    ]
    ctx["latestMessage"] = {
        "from": "Sarah",
        "body": "Hi Mom",
        "hasPhoto": False,
        "sentAt": 1804940000000,
        "seen": False,
    }
    ctx["recentConversations"] = [
        {"startedAt": 1804943400000, "summary": "Asked time."}
    ]
    block = format_user_context(ctx)
    assert "Saturday, March 13, 9 AM: Dentist, with Sarah, at Main St" in block
    assert (
        "Latest family message: from Sarah, not read yet. Call read_latest_message to "
        "read it." in block
    )
    assert "Hi Mom" not in block
    assert "2027-03-13: Asked time." in block
