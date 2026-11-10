# speech_guard.py
# Purpose: Checks on what the voice agent is about to say, applied in Assistant.llm_node
# (agent.py) before any of a reply reaches text-to-speech. The system prompt already tells
# the model to call flag_caregiver before speaking and never to promise what family will do,
# but Claude Haiku does not follow that every time: in repeated runs it said "I've let Anna
# know" without calling the tool, "I'm calling for help right now" before calling it, and
# "I've logged another" when nothing was logged. For a senior who fell or is lost these are
# dangerous, so they are enforced in code:
#
#   1. Words the model writes before a tool call in the same reply are never spoken (agent.py
#      drops them); the reply after the tool result is the one she hears.
#   2. A reply that says family was told, is being told, or that help is coming, is spoken
#      only when a tool result in this turn says someone was told (told_this_turn). With no
#      flag_caregiver call in the turn the model is run again and made to call it, so the
#      statement becomes true (FORCE_FLAG). When flag_caregiver was called and reached
#      nobody, she hears UNREACHED_LINE instead. Text the reply quotes (a family message
#      read aloud) is not the agent's own statement and is ignored.
#   3. In a turn where a tool that tells family ran, sentences that promise what family or
#      Sunny will do ("Anna is on the way", "I'm calling for help") are removed. A sentence
#      that gives the emergency number is kept unless Sunny claims to be the one calling.
#   4. When log_dose answered that a dose may repeat one already written down, the reply must
#      be the same-or-another question; anything else is replaced by the exact question from
#      the tool result.
#
# another_is_hers() is the other half of rule 4: log_dose honors the model's "another" only
# when her own words say so, or the agent's last words before her current turn asked that
# question and she did not answer "the same" (agent.py), so the model cannot infer a second
# dose from "about an hour ago".
#
# Known limits: the checks are word patterns, so a claim worded in a way not listed here
# passes, and the patterns are English only. Everything is pure text and chat-context
# inspection, unit tested without a model (tests/test_speech_guard.py).
#
# Last modified: 2026-11-10

from __future__ import annotations

import re
from typing import Final

from livekit.agents.llm import ChatContext

from config import EMERGENCY_NUMBER
from tools import SAME_OR_ANOTHER

# Tools whose result can state who in the family was told.
TOLD_TOOLS: Final = frozenset(
    {"flag_caregiver", "log_dose", "undo_last_dose", "send_family_message"}
)

# Sentinel returned by review_reply when the reply must not be spoken and the model must be
# made to call flag_caregiver instead.
FORCE_FLAG: Final = object()

_DANGER_LINE: Final = f"If you are hurt or in danger, call {EMERGENCY_NUMBER} now."

# What she hears when family could not be told: after a flag that reached nobody, or when a
# forced flag_caregiver call could not be made at all.
UNREACHED_LINE: Final = f"I couldn't reach your family from here. {_DANGER_LINE}"

# A tool result that says someone was told (tools._told, db_send_family_message).
_RESULT_SAYS_TOLD: Final = re.compile(
    r"\b(?:has|have) been told\b|\bwas already told\b|\bwent to\b", re.IGNORECASE
)

# A person or the family as the object of "let ... know" or "tell ...": anything but "you" or
# "me", so "I'll let you know" and "I've told you" do not count.
_OBJ = r"(?!you\b|me\b)[\w' ]{1,40}?"
_NOT_YOU = r"(?!you\b|me\b)"
_TELL_PAST = r"(?:told|alerted|notified|informed|messaged|texted|contacted|called)"
_TELL_ING = (
    r"(?:telling|alerting|notifying|informing|messaging|texting|contacting|calling)"
)
_TELL = r"(?:tell|alert|notify|inform|message|text|contact|call)"

# The agent's own statements that family has been or is being told, or that help is on its
# way. Offers ("Shall I let Anna know?") do not match.
_TOLD_NOW: Final = re.compile(
    r"(?:\bI(?:'ve| have)?(?: just| already)?|\band) let " + _OBJ + r" know"
    r"|\bI(?:'ve| have)?(?: just| already)? "
    + _TELL_PAST
    + " "
    + _NOT_YOU
    + r"|\bI(?:'ve| have)(?: just| already)? sent (?:help|someone|"
    + _OBJ
    + r" a )"
    r"|\bI(?:'m| am) letting " + _OBJ + r" know"
    r"|\bI(?:'m| am) "
    + _TELL_ING
    + " "
    + _NOT_YOU
    + r"|\bI(?:'m| am) sending (?:help|someone)"
    r"|\bI(?:'m| am) going to (?:let " + _OBJ + r" know|" + _TELL + " " + _NOT_YOU + ")"
    r"|\b(?:is|are) being told\b"
    r"|\bhelp is (?:coming|on (?:the|its) way)\b",
    re.IGNORECASE,
)

# "Anna has been told": a claim too, but also the honest answer to "Did you tell Anna?"
# later in a conversation, so it is allowed once any tool in the conversation said so.
_TOLD_PASSIVE: Final = re.compile(
    r"\b(?:has|have) been (?:told|notified|alerted|informed)\b", re.IGNORECASE
)

# The same statements about the immediate future. These count only in a reply that asks
# nothing, so the read-back before a family message ("I'll tell Sarah you're home. Shall I
# send it?") is left alone.
_TOLD_SOON: Final = re.compile(
    r"\bI(?:'ll| will) (?:let " + _OBJ + r" know|" + _TELL + " " + _NOT_YOU + ")",
    re.IGNORECASE,
)

# Sunny claiming to call or send someone itself: never true, removed even beside 911.
_SELF_ACTION: Final = re.compile(
    r"\bI(?:'m| am|'ll| will|'ve| have)(?: going to)? (?:call|calling|called|send|sending|sent)\b",
    re.IGNORECASE,
)

# Promises about what family will do, which Sunny cannot know.
_PROMISE: Final = re.compile(
    r"\bon (?:the|her|his|their|its) way\b"
    r"|\b(?:is|are|'s|'re) coming\b"
    r"|(?:\bwill|'ll) (?:call|come|help|reach|get you|take you|be (?:there|here|with you|in touch|by))\b"
    r"|\bhelp is (?:coming|on)\b",
    re.IGNORECASE,
)

# Text the reply quotes or reports from someone else: inside quotation marks, or after
# "wrote", "says" or "said" up to the end of the sentence.
_QUOTED: Final = re.compile(
    r"\"[^\"]*\"|“[^”]*”"
    r"|\b(?:wrote|writes|says|said)\b[:,]?[^.!?]*",
    re.IGNORECASE,
)

# The exact question inside a log_dose result that starts with tools.SAME_OR_ANOTHER.
_SAY_EXACTLY: Final = re.compile(r'Say exactly: "([^"]+)"')

# The agent's question offering the choice between the same dose and another one.
_SAME_OR_ANOTHER_ASKED: Final = re.compile(r"\bsame one\b", re.IGNORECASE)

# The senior's own words for a further dose, and for the same dose.
_SAID_ANOTHER: Final = re.compile(
    r"\b(?:another|a second|second one|one more|two more|different one)\b",
    re.IGNORECASE,
)
_SAID_SAME: Final = re.compile(r"\bsame\b", re.IGNORECASE)

# Sentence boundaries: end punctuation followed by white space.
_SENTENCE_END: Final = re.compile(r"(?<=[.!?])\s+")


def claims_family_told(text: str, told_before: bool = False) -> bool:
    """
    purpose: Whether a reply states, in the agent's own words, that family was told, is
             being told, or that help is coming. Quoted or reported text is ignored. A
             statement about the immediate future ("I'll let Anna know") counts only when
             the reply asks no question; "Anna has been told" counts only when no tool in
             the conversation has said so.
    @param text: (str) The whole reply the model wrote.
    @param told_before: (bool) A tool earlier in the conversation said someone was told.
    @return: (bool) True when the reply makes that statement.
    """
    own = _QUOTED.sub(" ", text)
    if _TOLD_NOW.search(own):
        return True
    if not told_before and _TOLD_PASSIVE.search(own):
        return True
    return "?" not in text and bool(_TOLD_SOON.search(own))


def _turn_outputs(chat_ctx: ChatContext) -> list[tuple[str, str]]:
    """
    purpose: The tool results since the senior last spoke, newest first.
    @param chat_ctx: (ChatContext) The context the model is answering.
    @return: (list[tuple[str, str]]) (tool name, result text) pairs.
    """
    outputs: list[tuple[str, str]] = []
    for item in reversed(chat_ctx.items):
        if item.type == "message" and item.role == "user":
            break
        if item.type == "function_call_output":
            outputs.append((item.name, item.output))
    return outputs


def told_this_turn(chat_ctx: ChatContext) -> str | None:
    """
    purpose: The sentence, from the newest tool result since the senior last spoke, that
             says someone in the family was told. It is the only thing a statement that
             family was told may rest on: a flag that reached nobody, or a dose logged
             within the label, tells no one.
    @param chat_ctx: (ChatContext) The context the model is answering.
    @return: (str | None) That sentence ("Anna has been told."), or None.
    """
    for name, output in _turn_outputs(chat_ctx):
        if name not in TOLD_TOOLS:
            continue
        for sentence in _SENTENCE_END.split(output.strip()):
            if _RESULT_SAYS_TOLD.search(sentence):
                return sentence
    return None


def _told_earlier(chat_ctx: ChatContext) -> bool:
    """
    purpose: Whether any tool result in the whole conversation says someone was told.
    @param chat_ctx: (ChatContext) The conversation.
    @return: (bool) True when one does.
    """
    return any(
        item.type == "function_call_output"
        and item.name in TOLD_TOOLS
        and _RESULT_SAYS_TOLD.search(item.output)
        for item in chat_ctx.items
    )


def pending_dose_question(chat_ctx: ChatContext) -> str | None:
    """
    purpose: The same-or-another question the newest tool result of this turn asks for, when
             that result is log_dose saying a dose may repeat one already written down.
    @param chat_ctx: (ChatContext) The context the model is answering.
    @return: (str | None) The exact question to ask, or None when none is pending.
    """
    outputs = _turn_outputs(chat_ctx)
    if not outputs or outputs[0][0] != "log_dose":
        return None
    if not outputs[0][1].startswith(SAME_OR_ANOTHER):
        return None
    match = _SAY_EXACTLY.search(outputs[0][1])
    return match.group(1) if match else None


def another_is_hers(chat_ctx: ChatContext) -> bool:
    """
    purpose: Whether "this is another dose" comes from the senior and not from the model:
             either her current words say so ("another", "a second one", "one more"), or the
             agent's last words before her current turn asked her whether it is the same one
             or another and she did not answer that it is the same. Only then may log_dose
             record "another".
    @param chat_ctx: (ChatContext) The context the model is answering.
    @return: (bool) True when a second dose may be recorded.
    """
    said_same = False
    seen_her_turn = False
    for item in reversed(chat_ctx.items):
        if item.type != "message":
            continue
        text = item.text_content or ""
        if item.role == "user":
            if seen_her_turn:
                return False
            if _SAID_ANOTHER.search(text):
                return True
            said_same = bool(_SAID_SAME.search(text))
            seen_her_turn = True
        elif item.role == "assistant" and seen_her_turn:
            asked = "?" in text and bool(_SAME_OR_ANOTHER_ASKED.search(text))
            return asked and not said_same
    return False


def without_promises(text: str) -> str:
    """
    purpose: Remove every sentence in which Sunny claims to call or send someone, and every
             sentence that promises what family will do unless it gives the emergency number
             ("Please call 911 now, they will help you" is kept).
    @param text: (str) The reply the model wrote.
    @return: (str) The reply without those sentences (possibly empty).
    """
    kept = [
        sentence
        for sentence in _SENTENCE_END.split(text.strip())
        if sentence
        and not _SELF_ACTION.search(_QUOTED.sub(" ", sentence))
        and (EMERGENCY_NUMBER in sentence or not _PROMISE.search(sentence))
    ]
    return " ".join(kept)


def review_reply(text: str, chat_ctx: ChatContext) -> str | object:
    """
    purpose: Decide what may be spoken for a reply that calls no tool.
    @param text: (str) The whole reply the model wrote.
    @param chat_ctx: (ChatContext) The context the model was answering.
    @return: (str | object) The text to speak, or FORCE_FLAG when the reply says family was
             told and no tool in this turn tried to tell them. The text is: the
             same-or-another question when log_dose asked for it and the reply is not that
             question; UNREACHED_LINE when the reply says family was told after a flag that
             reached nobody; the reply without its promises in a turn where a tool that
             tells family ran; and the reply itself in every other case.
    """
    question = pending_dose_question(chat_ctx)
    if question is not None:
        asks = "?" in text and bool(_SAME_OR_ANOTHER_ASKED.search(text))
        return text if asks else question

    told = told_this_turn(chat_ctx)
    ran = [name for name, _ in _turn_outputs(chat_ctx) if name in TOLD_TOOLS]
    if told is None and claims_family_told(text, _told_earlier(chat_ctx)):
        return UNREACHED_LINE if "flag_caregiver" in ran else FORCE_FLAG
    if not ran:
        return text
    cleaned = without_promises(text)
    if cleaned == text.strip():
        return text
    if cleaned:
        return cleaned
    return f"{told} {_DANGER_LINE}" if told else UNREACHED_LINE
