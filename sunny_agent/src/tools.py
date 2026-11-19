from datetime import UTC, date, datetime, timedelta
from zoneinfo import ZoneInfo

from config import US_CRISIS_LINE, US_EMERGENCY_NUMBER
from convex_client import ConvexMutation, ConvexQuery, mutation_as, query_as
from convex_types import (
    CANCEL_REMINDER_RESULT,
    CONFIRM_RESULT,
    FAMILY_MESSAGE_RESULT,
    FLAG_RESULT,
    LATEST_FAMILY_MESSAGE,
    LOG_DOSE_RESULT,
    MEDICATION_STATUS,
    REMEMBER_FACT_RESULT,
    SNOOZE_RESULT,
    TODAY,
    UNDO_DOSE_RESULT,
    AlreadyLoggedDose,
    AsNeededEntry,
    ConfirmResult,
    FlagStatus,
    LoggedDose,
    SnoozeResult,
    TaskStep,
    TodayEntry,
)

_DAY_ORDER = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
UNREACHABLE = "Family could not be reached from here; say exactly that, plainly."
EMERGENCY_LINES = (
    f" If they are hurt, fell, or are in danger, tell them to call {US_EMERGENCY_NUMBER}; if they "
    f"talk about hurting themselves, give {US_EMERGENCY_NUMBER} and {US_CRISIS_LINE}, the crisis line."
)
_DONE_STATES = {"confirmed", "resolved"}
ANYTIME = "anytime"


def format_time_for_voice(t: str) -> str:
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
    day_set = {d.lower() for d in days}
    if day_set == set(_DAY_ORDER):
        return "every day"
    if day_set == set(_DAY_ORDER[:5]):
        return "on weekdays"
    if day_set == set(_DAY_ORDER[5:]):
        return "on weekends"
    return "on " + ", ".join(d.capitalize() for d in _DAY_ORDER if d in day_set)


def to_local(epoch_ms: float, tz: str) -> datetime:
    return datetime.fromtimestamp(epoch_ms / 1000, tz=UTC).astimezone(ZoneInfo(tz))


def clock_for_voice(moment: datetime) -> str:
    return format_time_for_voice(moment.strftime("%H:%M"))


def spoken_date(day: date) -> str:
    return f"{day.strftime('%A, %B')} {day.day}"


def local_clock(epoch_ms: float, tz: str) -> str:
    return clock_for_voice(to_local(epoch_ms, tz))


def step_speech(step: TaskStep) -> str:
    text = step["text"].strip()
    end = "" if text.endswith((".", "!", "?")) else "."
    return f"Step {step['index'] + 1} of {step['count']}: {text}{end}"


def describe_instance(item: TodayEntry, tz: str) -> str:
    label = item["displayLabel"]
    anytime = item["scheduledTime"] == ANYTIME
    state = item["state"]
    if anytime:
        when = f"{label}, anytime today"
        open_status = "still to do today"
    else:
        when = f"{format_time_for_voice(item['scheduledTime'])}, {label}"
        open_status = "due now"
    confirmed_at = item["confirmedAt"]
    if state in _DONE_STATES and confirmed_at:
        status = f"done at {local_clock(confirmed_at, tz)}"
    elif (anytime and state != "missed") or state in ("due", "escalated"):
        status = open_status
    elif state == "missed":
        status = "not done yet"
    else:
        status = "later today"
    step = item["step"]
    if step is not None and state not in _DONE_STATES:
        status += (
            f", on step {step['index'] + 1} of {step['count']}: {step['text'].strip()}"
        )
    return f"{when}: {status}"


async def db_list_today(client: ConvexQuery, household_id: str, tz: str) -> str:
    items = await query_as(client, "agent:today", {"householdId": household_id}, TODAY)
    if not items:
        return "There is nothing on the schedule for today."
    return "Today: " + "; ".join(describe_instance(i, tz) for i in items) + "."


class StepsRead:
    def __init__(self) -> None:
        self._steps: dict[str, int] = {}

    def note(self, label: str, step: TaskStep | None) -> None:
        key = label.strip().lower()
        if step is None:
            self._steps.pop(key, None)
        else:
            self._steps[key] = step["index"]

    def step_for(self, said: str) -> int | None:
        needle = said.strip().lower()
        if not needle:
            return None
        matches = [index for key, index in self._steps.items() if needle in key]
        return matches[0] if len(matches) == 1 else None


async def db_confirm_task(
    client: ConvexMutation,
    household_id: str,
    tz: str,
    task_name: str,
    steps_read: StepsRead | None = None,
) -> str:
    r = await mutation_as(
        client,
        "agent:confirmDueTask",
        {
            "householdId": household_id,
            "label": task_name or None,
            "step": None if steps_read is None else steps_read.step_for(task_name),
        },
        CONFIRM_RESULT,
    )
    status = r["status"]
    label = r.get("displayLabel") or task_name
    if steps_read is not None and status in ("advanced", "other_step", "confirmed"):
        steps_read.note(label, None if status == "confirmed" else r.get("step"))
    if status == "confirmed":
        return f"Confirmed: {label}{_at_clock(r.get('confirmedAt'), tz)}."
    step = r.get("step")
    if status == "advanced" and step is not None:
        return (
            f"Step {step['index']} of {step['count']} of {label} is done; the task is "
            f"not done until the last step. Next: {step_speech(step)} Read that step to them."
        )
    if status == "other_step":
        current = "" if step is None else f" It is on {step_speech(step)}"
        return (
            f"Nothing was marked done: {label} is on another step than the one read "
            f"out.{current} Read that step to them."
        )
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


def _at_clock(epoch_ms: float | None, tz: str) -> str:
    return "" if epoch_ms is None else f" at {local_clock(epoch_ms, tz)}"


def _task_outcome(
    r: ConfirmResult | SnoozeResult, label: str, task_name: str, tz: str
) -> str | None:
    status = r["status"]
    scheduled = r.get("scheduledTime")
    if status == "already_done":
        return (
            f"Already done: {label} was confirmed{_at_clock(r.get('confirmedAt'), tz)}."
        )
    if status == "not_due_yet" and scheduled is not None and scheduled != ANYTIME:
        return f"{label} is not due until {format_time_for_voice(scheduled)}."
    if status == "not_found":
        return f"I don't see {task_name} on today's schedule."
    return None


async def db_create_senior_reminder(
    client: ConvexMutation,
    household_id: str,
    tz: str,
    title: str,
    time: str,
    on_date: str = "",
    days: list[str] | None = None,
) -> str:
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
    client: ConvexMutation, household_id: str, title_query: str
) -> str:
    r = await mutation_as(
        client,
        "agent:cancelSeniorReminder",
        {"householdId": household_id, "query": title_query},
        CANCEL_REMINDER_RESULT,
    )
    titles = r["titles"]
    if r["status"] == "cancelled":
        return f"Cancelled the reminder to {titles[0]}."
    if r["status"] == "ambiguous":
        return f"Several reminders match: {', '.join(titles)}. Ask which one to cancel."
    return (
        f"No reminder they created matches '{title_query}'. Reminders set up by "
        "family can only be changed by family."
    )


def one_line(value: object) -> str:
    return " ".join(str(value or "").split())


def quoted(text: object) -> str:
    return '"' + one_line(text).replace('"', "'") + '"'


def join_names(names: list[str]) -> str:
    if not names:
        return "family"
    if len(names) == 1:
        return names[0]
    return f"{', '.join(names[:-1])} and {names[-1]}"


def _same_local_day(a_ms: float, b_ms: float, tz: str) -> bool:
    return to_local(a_ms, tz).date() == to_local(b_ms, tz).date()


def now_epoch_ms() -> float:
    return datetime.now(UTC).timestamp() * 1000


def _dose_time(epoch_ms: float, now_ms: float, tz: str) -> str:
    clock = local_clock(epoch_ms, tz)
    return clock if _same_local_day(epoch_ms, now_ms, tz) else f"{clock} yesterday"


def describe_as_needed(med: AsNeededEntry, tz: str, now_ms: float | None = None) -> str:
    reference = now_ms if now_ms is not None else now_epoch_ms()
    label = one_line(med["displayLabel"])
    pill = med["pillDescription"]
    if pill:
        label += f" ({one_line(pill)})"
    limits = []
    max_per_day = med["maxPerDay"]
    if max_per_day:
        limits.append(f"up to {max_per_day} in 24 hours")
    min_hours = med["minHoursBetween"]
    if min_hours:
        limits.append(f"at least {float(min_hours):g} hours apart")
    label_text = (
        f"the label says {', '.join(limits)}" if limits else "no limits are on file"
    )
    taken = [_dose_time(t, reference, tz) for t in med["takenLast24h"]]
    taken_text = ", ".join(taken) if taken else "none"
    if max_per_day:
        taken_text += f" ({len(taken)} of {max_per_day})"
    text = f"{label}: {label_text}. Taken in the last 24 hours: {taken_text}."
    if now_ms is None:
        return text
    next_at = med["nextWithinLabelAt"]
    if next_at is None:
        text += " Another would be within the label now."
    else:
        day = "" if _same_local_day(next_at, now_ms, tz) else " tomorrow"
        when = f"after {local_clock(next_at, tz)}{day}"
        if med["remainingToday"] == 0:
            text += f" That is the most the label allows; the next would be {when}."
        else:
            text += f" Another would be within the label {when}."
    days_used = med["daysUsedLast7"]
    if days_used:
        text += f" Used on {days_used} of the last 7 days."
    return text


async def db_snooze_task(
    client: ConvexMutation, household_id: str, tz: str, task_name: str
) -> str:
    r = await mutation_as(
        client,
        "agent:snoozeDueTask",
        {"householdId": household_id, "label": task_name or None},
        SNOOZE_RESULT,
    )
    status = r["status"]
    label = r["displayLabel"] or task_name
    if status == "snoozed":
        until = r["snoozedUntil"]
        if until is None:
            return f"Snoozed {label}."
        return f"Snoozed {label}; the next reminder is at {local_clock(until, tz)}."
    shared = _task_outcome(r, label, task_name, tz)
    if shared is not None:
        return shared
    if status == "not_due_yet":
        return f"{label} can be done anytime today; there is no reminder to snooze."
    if status == "ambiguous":
        return f"Several tasks are due: {', '.join(r['options'])}. Ask which one."
    return "Nothing is due right now."


async def db_medication_status(client: ConvexQuery, household_id: str, tz: str) -> str:
    r = await query_as(
        client,
        "agent:medicationStatus",
        {"householdId": household_id},
        MEDICATION_STATUS,
    )
    now_ms = now_epoch_ms()
    scheduled = r["scheduled"]
    as_needed = r["asNeeded"]
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


SAME_OR_ANOTHER = "Nothing new was logged yet"


async def db_log_dose(
    client: ConvexMutation,
    household_id: str,
    tz: str,
    medication: str,
    minutes_ago: int,
    conversation_id: str | None,
    another: bool = False,
) -> str:
    r = await mutation_as(
        client,
        "agent:logAsNeededDose",
        {
            "householdId": household_id,
            "label": medication or None,
            "minutesAgo": max(0, int(minutes_ago)),
            "another": another,
            "conversationId": conversation_id or None,
        },
        LOG_DOSE_RESULT,
    )
    if r["status"] == "logged":
        return _logged_text(r, tz)
    if r["status"] == "already_logged":
        return _already_logged_text(r, tz)
    options = ", ".join(r["options"])
    if r["status"] == "no_rule":
        return (
            "Nothing was logged: family has not set up an as-needed medication with label "
            "limits. Say what was taken today if asked, and offer to let family know or "
            "suggest asking the pharmacy."
        )
    if r["status"] == "not_found":
        return (
            f"Nothing was logged: no as-needed medication matches. On file: {options}."
        )
    if r["status"] == "ambiguous":
        return f"Nothing was logged yet: ask which one they took: {options}."
    return (
        f"Nothing was logged: {options} is a scheduled medication that is due now. If "
        "that is what they took, use confirm_task."
    )


def _logged_line(med: AsNeededEntry, taken_at: float, tz: str) -> str:
    return (
        f"Logged {one_line(med['displayLabel'])} at {local_clock(taken_at, tz)}. "
        f"{describe_as_needed(med, tz, now_epoch_ms())}"
    )


def _already_logged_text(r: AlreadyLoggedDose, tz: str) -> str:
    med = r["medication"]
    if r["repeatCall"]:
        return _logged_line(med, r["takenAt"], tz)
    return (
        f'{SAME_OR_ANOTHER}. Say exactly: "I have one {one_line(med["displayLabel"])} '
        f"written down at {local_clock(r['takenAt'], tz)}. Is that the same one, or did "
        'you take another?" Do not say anything was logged and do not say they already '
        "told you. If they answer that it is another one, call log_dose again with "
        "another set to true."
    )


def _logged_text(r: LoggedDose, tz: str) -> str:
    med = r["medication"]
    text = _logged_line(med, r["takenAt"], tz)
    breaches = []
    if r["overDailyMax"]:
        breaches.append(f"{r['count']} in 24 hours, more than the label allows")
    if r["tooSoon"]:
        min_hours = med["minHoursBetween"]
        hours = f"{float(min_hours):g} " if min_hours else ""
        breaches.append(f"sooner than the label's {hours}hours apart")
    if breaches:
        text += f" This dose is {' and '.join(breaches)}. " + _told(
            r["flagStatus"], r["flagged"]
        )
    return text


def _told(status: FlagStatus | None, names: list[str]) -> str:
    if status == "already_flagged" and names:
        return f"{join_names(names)} was already told about this a few minutes ago."
    if status == "flagged" and names:
        return f"{join_names(names)} has been told."
    if status == "rate_limited":
        return "No more messages can be sent to family right now; say so plainly."
    return UNREACHABLE


async def db_undo_last_dose(
    client: ConvexMutation,
    household_id: str,
    tz: str,
    medication: str,
    conversation_id: str | None,
) -> str:
    r = await mutation_as(
        client,
        "agent:undoLastDose",
        {
            "householdId": household_id,
            "label": medication or None,
            "conversationId": conversation_id or None,
        },
        UNDO_DOSE_RESULT,
    )
    if r["status"] == "removed":
        text = (
            f"Removed the {one_line(r['displayLabel'])} written down at "
            f"{local_clock(r['takenAt'], tz)}."
        )
        if r["corrected"]:
            text += f" {join_names(r['corrected'])} has been told it was a mistake."
        return text
    if r["status"] == "ambiguous":
        return f"Ask which one to take back: {', '.join(r['options'])}."
    return (
        "Nothing was changed: only a dose written down in this conversation can be taken "
        "back. Say plainly that you cannot change earlier records, and offer to let family "
        "know."
    )


async def db_remember_fact(
    client: ConvexMutation, household_id: str, fact: str, conversation_id: str | None
) -> str:
    r = await mutation_as(
        client,
        "agent:rememberFact",
        {
            "householdId": household_id,
            "fact": fact,
            "conversationId": conversation_id or None,
        },
        REMEMBER_FACT_RESULT,
    )
    if r["status"] == "already_known":
        return "That was already noted."
    return "Noted."


async def db_flag_caregiver(
    client: ConvexMutation,
    household_id: str,
    reason: str,
    detail: str,
    conversation_id: str | None,
) -> str:
    r = await mutation_as(
        client,
        "agent:flagCaregiver",
        {
            "householdId": household_id,
            "reason": reason,
            "detail": detail,
            "conversationId": conversation_id or None,
        },
        FLAG_RESULT,
    )
    text = _told(r["status"], r["notified"])
    if reason == "distress":
        text += EMERGENCY_LINES
    return text


async def db_send_family_message(
    client: ConvexMutation,
    household_id: str,
    to: str,
    message: str,
    conversation_id: str | None,
) -> str:
    r = await mutation_as(
        client,
        "agent:sendFamilyMessage",
        {
            "householdId": household_id,
            "to": to or None,
            "body": message,
            "conversationId": conversation_id or None,
        },
        FAMILY_MESSAGE_RESULT,
    )
    names = join_names(r["recipients"])
    status = r["status"]
    if status == "already_sent":
        if r["earlierStatus"] == "unreachable":
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


def spoken_when(epoch_ms: float, tz: str) -> str:
    moment = to_local(epoch_ms, tz)
    today = to_local(now_epoch_ms(), tz).date()
    if moment.date() == today:
        return f"today at {clock_for_voice(moment)}"
    if moment.date() == today - timedelta(days=1):
        return f"yesterday at {clock_for_voice(moment)}"
    return f"on {spoken_date(moment)}"


async def db_read_latest_message(
    client: ConvexMutation, household_id: str, tz: str
) -> str:
    r = await mutation_as(
        client,
        "agent:readLatestMessage",
        {"householdId": household_id},
        LATEST_FAMILY_MESSAGE,
    )
    if r is None:
        return "There are no messages from family."
    sender = one_line(r["from"]) or "family"
    when = spoken_when(r["sentAt"], tz)
    body = r["body"]
    photo = r["hasPhoto"]
    if body and photo:
        return f"From {sender}, {when}, with a photo: {quoted(body)}"
    if body:
        return f"From {sender}, {when}: {quoted(body)}"
    if photo:
        return f"{sender} sent a photo {when}, with no words."
    return f"{sender} sent a message {when} with no words."
