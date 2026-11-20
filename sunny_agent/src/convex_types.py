from typing import Literal, NotRequired

from pydantic import TypeAdapter
from typing_extensions import TypedDict

InstanceState = Literal[
    "upcoming", "due", "escalated", "confirmed", "missed", "resolved"
]
TaskType = Literal["medication", "appointment", "routine", "checklist", "reminder"]
FlagStatus = Literal["flagged", "already_flagged", "unreachable", "rate_limited"]


class TaskStep(TypedDict):
    index: int
    count: int
    text: str


class TodayEntry(TypedDict):
    instanceId: str
    type: TaskType
    displayLabel: str
    spokenPrompt: str
    pillDescription: str | None
    checklistItems: list[str]
    step: TaskStep | None
    scheduledTime: str
    state: InstanceState
    confirmedAt: float | None


class AsNeededEntry(TypedDict):
    displayLabel: str
    pillDescription: str | None
    maxPerDay: int | None
    minHoursBetween: float | None
    takenToday: list[float]
    takenLast24h: list[float]
    remainingToday: int | None
    nextWithinLabelAt: float | None
    daysUsedLast7: int


class Household(TypedDict):
    seniorPreferredName: str
    timezone: str
    localNow: str
    weatherLocation: str | None


class Caregiver(TypedDict):
    name: str


class UpcomingEvent(TypedDict):
    title: str
    startsAt: float
    place: str | None
    visitorName: str | None


FamilyMessage = TypedDict(
    "FamilyMessage",
    {"from": str, "body": str | None, "hasPhoto": bool, "sentAt": float, "seen": bool},
)


class MailNote(TypedDict):
    text: str
    receivedAt: float


class LifeProfileEntry(TypedDict):
    category: str
    name: str
    details: str | None


class SensitiveTopic(TypedDict):
    topic: str
    guidance: str


class MemoryFact(TypedDict):
    fact: str
    source: str
    verified: bool


class RecentConversation(TypedDict):
    startedAt: float
    summary: str


class HouseholdList(TypedDict):
    openCount: int
    items: list[str]


class AgentContext(TypedDict):
    household: Household
    caregivers: list[Caregiver]
    today: list[TodayEntry]
    asNeeded: list[AsNeededEntry]
    events: list[UpcomingEvent]
    latestMessage: FamilyMessage | None
    seniorNotes: list[MailNote]
    lifeProfile: list[LifeProfileEntry]
    sensitiveTopics: list[SensitiveTopic]
    memory: list[MemoryFact]
    recentConversations: list[RecentConversation]
    recentQuestionTopics: list[str]
    list: HouseholdList


class ConfirmResult(TypedDict):
    status: Literal[
        "confirmed",
        "advanced",
        "already_done",
        "nothing_due",
        "not_found",
        "ambiguous",
        "not_due_yet",
        "other_step",
    ]
    displayLabel: NotRequired[str]
    scheduledTime: NotRequired[str]
    confirmedAt: NotRequired[float | None]
    step: NotRequired[TaskStep | None]
    options: NotRequired[list[TodayEntry]]


SnoozeStatus = Literal[
    "snoozed",
    "nothing_due",
    "not_found",
    "ambiguous",
    "already_done",
    "not_due_yet",
]


class SnoozeResult(TypedDict):
    status: SnoozeStatus
    displayLabel: str | None
    scheduledTime: str | None
    snoozedUntil: float | None
    confirmedAt: float | None
    options: list[str]


class CancelReminderResult(TypedDict):
    status: Literal["cancelled", "not_found", "ambiguous"]
    titles: list[str]


class MedicationStatus(TypedDict):
    scheduled: list[TodayEntry]
    asNeeded: list[AsNeededEntry]


class LoggedDose(TypedDict):
    status: Literal["logged"]
    medication: AsNeededEntry
    takenAt: float
    overDailyMax: bool
    tooSoon: bool
    count: int
    flagStatus: FlagStatus | None
    flagged: list[str]


class AlreadyLoggedDose(TypedDict):
    status: Literal["already_logged"]
    medication: AsNeededEntry
    takenAt: float
    repeatCall: bool


class DoseNotLogged(TypedDict):
    status: Literal["no_rule", "not_found", "ambiguous", "scheduled_due"]
    options: list[str]


LogDoseResult = LoggedDose | AlreadyLoggedDose | DoseNotLogged


class RemovedDose(TypedDict):
    status: Literal["removed"]
    displayLabel: str
    takenAt: float
    corrected: list[str]


class DoseNotRemoved(TypedDict):
    status: Literal["nothing_to_undo", "no_rule", "not_found", "ambiguous"]
    options: list[str]


UndoDoseResult = RemovedDose | DoseNotRemoved


class RememberFactResult(TypedDict):
    status: Literal["saved", "already_known"]


class FlagResult(TypedDict):
    status: FlagStatus
    notified: list[str]


SendStatus = Literal["sent", "sent_to_family", "unreachable"]


class FamilyMessageResult(TypedDict):
    status: SendStatus | Literal["already_sent", "rate_limited"]
    recipients: list[str]
    earlierStatus: SendStatus | None


class SpokenListItem(TypedDict):
    text: str
    status: Literal["added", "already_on_list", "list_full", "too_many"]


class QuestionRow(TypedDict):
    question: str
    topic: str
    outcome: Literal["answered", "routed", "unsure"]
    toolsUsed: list[str]
    askedAt: int | None


class TickListItemResult(TypedDict):
    status: Literal["ticked", "not_found", "ambiguous"]
    text: str | None
    options: list[str]


TODAY = TypeAdapter[list[TodayEntry]](list[TodayEntry])
AGENT_CONTEXT = TypeAdapter[AgentContext](AgentContext)
CONFIRM_RESULT = TypeAdapter[ConfirmResult](ConfirmResult)
SNOOZE_RESULT = TypeAdapter[SnoozeResult](SnoozeResult)
CANCEL_REMINDER_RESULT = TypeAdapter[CancelReminderResult](CancelReminderResult)
MEDICATION_STATUS = TypeAdapter[MedicationStatus](MedicationStatus)
LOG_DOSE_RESULT = TypeAdapter[LogDoseResult](LogDoseResult)
UNDO_DOSE_RESULT = TypeAdapter[UndoDoseResult](UndoDoseResult)
REMEMBER_FACT_RESULT = TypeAdapter[RememberFactResult](RememberFactResult)
FLAG_RESULT = TypeAdapter[FlagResult](FlagResult)
FAMILY_MESSAGE_RESULT = TypeAdapter[FamilyMessageResult](FamilyMessageResult)
LATEST_FAMILY_MESSAGE = TypeAdapter[FamilyMessage | None](FamilyMessage | None)
SPOKEN_LIST_ITEMS = TypeAdapter[list[SpokenListItem]](list[SpokenListItem])
OPEN_LIST_ITEMS = TypeAdapter[list[str]](list[str])
TICK_LIST_ITEM_RESULT = TypeAdapter[TickListItemResult](TickListItemResult)
CONVERSATION_ID = TypeAdapter[str](str)
