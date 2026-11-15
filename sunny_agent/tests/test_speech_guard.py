import pytest
from livekit.agents.llm import ChatContext, ChatRole, FunctionCallOutput

from speech_guard import (
    FORCE_FLAG,
    another_is_hers,
    claims_family_told,
    review_reply,
    told_this_turn,
    without_promises,
)


def _ctx(*tool_results: tuple[str, str], earlier: bool = False) -> ChatContext:
    ctx = ChatContext.empty()
    if earlier:
        ctx.items.append(
            FunctionCallOutput(
                name="flag_caregiver",
                call_id="c0",
                output="Anna has been told.",
                is_error=False,
            )
        )
    ctx.add_message(role="user", content="I fell in the kitchen.")
    for index, (name, output) in enumerate(tool_results):
        ctx.items.append(
            FunctionCallOutput(
                name=name, call_id=f"c{index + 1}", output=output, is_error=False
            )
        )
    return ctx


@pytest.mark.parametrize(
    "text",
    [
        "I've let Anna know you're scared and want to go home.",
        "I have let your family know.",
        "I'm letting your family know right away.",
        "I'm letting Anna know right now. Please call 911.",
        "I've told Anna about the call.",
        "I'm alerting your family right now.",
        "I'm calling for help right now.",
        "I'm sending someone over.",
        "You're safe, and family is being told.",
        "I'll let Anna know right away.",
        "I will tell Sarah about it.",
    ],
)
def test_statements_that_family_was_told_are_claims(text: str) -> None:
    assert claims_family_told(text)


@pytest.mark.parametrize(
    "text",
    [
        "Would you like me to let Anna know?",
        "I can let Anna know if you like.",
        "I'll let you know when it is time.",
        "I've told you everything on the list.",
        "I'll tell Sarah you're home. Shall I send it?",
        "I'll send Sarah: I'm home. Shall I send it?",
        "Anna knows about your appointment tomorrow.",
        "You took your morning pills at 8:10.",
        "I'm listening.",
    ],
)
def test_offers_and_ordinary_replies_are_not_claims(text: str) -> None:
    assert not claims_family_told(text)


def test_told_this_turn_reads_only_results_after_her_last_line() -> None:
    assert told_this_turn(_ctx(earlier=True)) is None
    assert told_this_turn(_ctx(("list_today", "Today: nothing."))) is None
    assert (
        told_this_turn(_ctx(("flag_caregiver", "Anna has been told.")))
        == "Anna has been told."
    )
    assert told_this_turn(_ctx(("log_dose", "Logged. Anna has been told."))) is not None


def test_a_claim_without_a_tool_result_forces_a_flag() -> None:
    assert review_reply("I've let Anna know you fell.", _ctx()) is FORCE_FLAG
    assert review_reply("I've let Anna know.", _ctx(earlier=True)) is FORCE_FLAG


def test_a_claim_after_the_tool_answered_is_spoken_as_written() -> None:
    text = "I've let Anna know you fell. Please call 911 now."
    assert review_reply(text, _ctx(("flag_caregiver", "Anna has been told."))) == text


def test_ordinary_replies_pass_through_unchanged() -> None:
    text = "It will be sunny tomorrow, and Sarah is coming at 3."
    assert review_reply(text, _ctx()) == text


def test_promises_are_removed_after_a_flag() -> None:
    ctx = _ctx(("flag_caregiver", "Anna has been told."))
    assert (
        review_reply(
            "I've let Anna know. Anna is on the way to you. Please call 911 now.", ctx
        )
        == "I've let Anna know. Please call 911 now."
    )
    assert (
        review_reply("I've let Anna know. She will be in touch right away.", ctx)
        == "I've let Anna know."
    )


def test_a_reply_that_was_all_promises_falls_back_to_the_tool_result() -> None:
    ctx = _ctx(("flag_caregiver", "Anna has been told."))
    assert (
        review_reply("I'm calling for help right now.", ctx)
        == "Anna has been told. If you are hurt or in danger, call 911 now."
    )


def test_without_promises_keeps_everything_else() -> None:
    assert without_promises("Stay calm. Help is on the way. Call 911 now.") == (
        "Stay calm. Call 911 now."
    )
    assert without_promises("Don't send any money.") == "Don't send any money."


REPEAT_RESULT = (
    'Nothing new was logged yet. Say exactly: "I have one Pain reliever written down at '
    '1:30 PM. Is that the same one, or did you take another?" Do not say anything was logged.'
)
REPEAT_QUESTION = (
    "I have one Pain reliever written down at 1:30 PM. Is that the same one, or did you "
    "take another?"
)


def test_a_refused_repeat_dose_is_answered_with_the_question() -> None:
    ctx = _ctx(("log_dose", REPEAT_RESULT))
    assert review_reply("I've logged another Tylenol.", ctx) == REPEAT_QUESTION
    asked = "I have one written down at 1:30. Is that the same one, or another?"
    assert review_reply(asked, ctx) == asked
    logged = _ctx(("log_dose", "Logged Pain reliever at 1:30 PM."))
    assert review_reply("I've logged it.", logged) == "I've logged it."


def _talk(*lines: tuple[ChatRole, str]) -> ChatContext:
    ctx = ChatContext.empty()
    for role, text in lines:
        ctx.add_message(role=role, content=text)
    return ctx


def test_another_is_believed_only_from_her() -> None:
    assert another_is_hers(
        _talk(
            ("user", "I took a Tylenol."),
            ("assistant", REPEAT_QUESTION),
            ("user", "No, I took another one."),
        )
    )
    assert not another_is_hers(
        _talk(
            ("user", "I just took a Tylenol."),
            ("assistant", "I've logged the Tylenol at 1:30."),
            ("user", "I took a Tylenol about an hour ago."),
        )
    )
    assert another_is_hers(_talk(("user", "I took another Tylenol.")))
    assert another_is_hers(
        _talk(
            ("assistant", REPEAT_QUESTION),
            ("user", "It was a different one."),
        )
    )
    assert not another_is_hers(_talk(("user", "I took a Tylenol.")))
    assert not another_is_hers(
        _talk(
            ("assistant", REPEAT_QUESTION),
            ("user", "The same one."),
            ("assistant", "All right."),
            ("user", "I took a Tylenol an hour ago."),
        )
    )


DISTRESS_RESULT = (
    "Anna has been told. If they are hurt, fell, or are in danger, tell them to call 911; "
    "if they talk about hurting themselves, give 911 and 988, the crisis line."
)
UNREACHABLE_RESULT = "Family could not be reached from here; say exactly that, plainly."


@pytest.mark.parametrize(
    "text",
    [
        "Help is on the way.",
        "I called an ambulance for you.",
        "I've called Anna.",
        "I've sent Anna a message.",
        "Anna has been told.",
        "Okay, I let Anna know.",
        "I'm going to call Anna.",
    ],
)
def test_more_wordings_of_the_claim_force_a_flag(text: str) -> None:
    assert review_reply(text, _ctx()) is FORCE_FLAG


@pytest.mark.parametrize(
    "text",
    [
        "Anna wrote: I've told Dr Lee you will be late.",
        'Sarah sent this: "I\'ve told Anna to pick you up."',
        "Your message from Anna says I've told the doctor. Want me to read it?",
    ],
)
def test_quoted_or_reported_words_are_not_the_agents_claim(text: str) -> None:
    assert review_reply(text, _ctx()) == text


def test_a_claim_after_a_flag_that_reached_nobody_is_replaced() -> None:
    ctx = _ctx(("flag_caregiver", UNREACHABLE_RESULT))
    assert told_this_turn(ctx) is None
    assert review_reply("I've let Anna know.", ctx) == (
        "I couldn't reach your family from here. If you are hurt or in danger, call 911 now."
    )
    honest = "I couldn't reach your family from here."
    assert review_reply(honest, ctx) == honest


def test_a_logged_dose_is_not_grounds_for_saying_family_was_told() -> None:
    ctx = _ctx(("log_dose", "Logged Pain reliever at 1:30 PM."))
    assert review_reply("I've logged it and let Anna know.", ctx) is FORCE_FLAG
    past = _ctx(("log_dose", "Logged Pain reliever at 1:30 PM. Anna has been told."))
    text = "That's sooner than the label's 6 hours apart. I've let Anna know."
    assert review_reply(text, past) == text


def test_the_fallback_never_speaks_tool_instructions() -> None:
    ctx = _ctx(("flag_caregiver", DISTRESS_RESULT))
    assert review_reply("Anna is on the way.", ctx) == (
        "Anna has been told. If you are hurt or in danger, call 911 now."
    )


def test_the_emergency_number_is_kept_unless_sunny_claims_to_call() -> None:
    ctx = _ctx(("flag_caregiver", DISTRESS_RESULT))
    keep = "I've let Anna know. Please call 911 now, they will help you."
    assert review_reply(keep, ctx) == keep
    assert review_reply("I've let Anna know. I'm calling 911 for you.", ctx) == (
        "I've let Anna know."
    )
    assert review_reply("I've let Anna know. She'll be there soon.", ctx) == (
        "I've let Anna know."
    )
    assert review_reply("I've let Anna know. Anna will reach out to you.", ctx) == (
        "I've let Anna know."
    )


def test_has_been_told_is_fine_once_a_tool_said_so_earlier() -> None:
    text = "Yes, Anna has been told."
    assert review_reply(text, _ctx(earlier=True)) == text
    assert review_reply(text, _ctx()) is FORCE_FLAG


def test_a_dose_reply_must_be_the_question_itself() -> None:
    ctx = _ctx(("log_dose", REPEAT_RESULT))
    assert review_reply("I've logged another. Anything else?", ctx) == REPEAT_QUESTION


def test_another_needs_her_word_or_an_answer_that_is_not_the_same() -> None:
    assert not another_is_hers(
        _talk(
            ("assistant", "Would you like another reminder?"),
            ("user", "I took a Tylenol an hour ago."),
        )
    )
    assert not another_is_hers(_talk(("user", "Tell me again what time it is.")))
    assert not another_is_hers(
        _talk(("assistant", REPEAT_QUESTION), ("user", "The same one."))
    )
    assert another_is_hers(_talk(("assistant", REPEAT_QUESTION), ("user", "No.")))
