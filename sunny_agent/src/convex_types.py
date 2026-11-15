from typing import Literal, TypedDict

InstanceState = Literal[
    "upcoming", "due", "escalated", "confirmed", "missed", "resolved"
]
TaskType = Literal["medication", "appointment", "routine", "checklist", "reminder"]
FlagStatus = Literal["flagged", "already_flagged", "unreachable", "rate_limited"]


class TodayEntry(TypedDict, total=False):
    instanceId: str
    type: TaskType
    displayLabel: str
    spokenPrompt: str
    pillDescription: str | None
    checklistItems: list[str]
    scheduledTime: str
    state: InstanceState
    confirmedAt: float | None


class AsNeededEntry(TypedDict, total=False):
    displayLabel: str
    pillDescription: str | None
    maxPerDay: int | None
    minHoursBetween: float | None
    takenToday: list[float]
    takenLast24h: list[float]
    remainingToday: int | None
    nextWithinLabelAt: float | None
    daysUsedLast7: int


class Household(TypedDict, total=False):
    seniorPreferredName: str
    timezone: str
    localNow: str
    weatherLocation: str | None


class Caregiver(TypedDict, total=False):
    name: str


class UpcomingEvent(TypedDict, total=False):
    title: str
    startsAt: float
    place: str | None
    visitorName: str | None


FamilyMessage = TypedDict(
    "FamilyMessage",
    {"from": str, "body": str | None, "hasPhoto": bool, "sentAt": float, "seen": bool},
    total=False,
)


class LifeProfileEntry(TypedDict, total=False):
    category: str
    name: str
    details: str | None


class SensitiveTopic(TypedDict, total=False):
    topic: str
    guidance: str


class MemoryFact(TypedDict, total=False):
    fact: str
    source: str
    verified: bool


class RecentConversation(TypedDict, total=False):
    startedAt: float
    summary: str


class HouseholdList(TypedDict, total=False):
    openCount: int
    items: list[str]


class AgentContext(TypedDict, total=False):
    household: Household
    caregivers: list[Caregiver]
    today: list[TodayEntry]
    asNeeded: list[AsNeededEntry]
    events: list[UpcomingEvent]
    latestMessage: FamilyMessage | None
    lifeProfile: list[LifeProfileEntry]
    sensitiveTopics: list[SensitiveTopic]
    memory: list[MemoryFact]
    recentConversations: list[RecentConversation]
    recentQuestionTopics: list[str]
    list: HouseholdList


class TaskOutcome(TypedDict, total=False):
    status: Literal[
        "confirmed",
        "snoozed",
        "already_done",
        "nothing_due",
        "not_found",
        "ambiguous",
        "not_due_yet",
    ]
    displayLabel: str | None
    scheduledTime: str
    confirmedAt: float


class ConfirmResult(TaskOutcome, total=False):
    options: list[TodayEntry]


class SnoozeResult(TaskOutcome, total=False):
    snoozedUntil: float
    options: list[str]


class CancelReminderResult(TypedDict, total=False):
    status: Literal["cancelled", "not_found", "ambiguous"]
    titles: list[str]


class MedicationStatus(TypedDict, total=False):
    scheduled: list[TodayEntry]
    asNeeded: list[AsNeededEntry]


class LogDoseResult(TypedDict, total=False):
    status: Literal[
        "logged",
        "already_logged",
        "no_rule",
        "not_found",
        "ambiguous",
        "scheduled_due",
    ]
    medication: AsNeededEntry
    takenAt: float
    repeatCall: bool
    overDailyMax: bool
    tooSoon: bool
    count: int
    flagStatus: FlagStatus | None
    flagged: list[str]
    options: list[str]


class UndoDoseResult(TypedDict, total=False):
    status: Literal["removed", "nothing_to_undo", "no_rule", "not_found", "ambiguous"]
    displayLabel: str
    takenAt: float
    corrected: list[str]
    options: list[str]


class RememberFactResult(TypedDict, total=False):
    status: Literal["saved", "already_known"]


class FlagResult(TypedDict, total=False):
    status: FlagStatus
    notified: list[str]


SendStatus = Literal["sent", "sent_to_family", "unreachable"]


class FamilyMessageResult(TypedDict, total=False):
    status: SendStatus | Literal["already_sent", "rate_limited"]
    recipients: list[str]
    earlierStatus: SendStatus | None


class SpokenListItem(TypedDict, total=False):
    text: str
    status: Literal["added", "already_on_list", "list_full", "too_many"]


class QuestionRow(TypedDict):
    question: str
    topic: str
    outcome: Literal["answered", "routed", "unsure"]
    toolsUsed: list[str]
    askedAt: int | None


class TickListItemResult(TypedDict, total=False):
    status: Literal["ticked", "not_found", "ambiguous"]
    text: str | None
    options: list[str]
