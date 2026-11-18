from __future__ import annotations

import re
from enum import Enum
from typing import Final

from livekit.agents.llm import ChatContext

from config import US_EMERGENCY_NUMBER
from tools import SAME_OR_ANOTHER

TOLD_TOOLS: Final = frozenset(
    {"flag_caregiver", "log_dose", "undo_last_dose", "send_family_message"}
)


class ForceFlag(Enum):
    FORCE_FLAG = "force_flag"


FORCE_FLAG: Final = ForceFlag.FORCE_FLAG

_DANGER_LINE: Final = f"If you are hurt or in danger, call {US_EMERGENCY_NUMBER} now."

UNREACHED_LINE: Final = f"I couldn't reach your family from here. {_DANGER_LINE}"

_RESULT_SAYS_TOLD: Final = re.compile(
    r"\b(?:has|have) been told\b|\bwas already told\b|\bwent to\b", re.IGNORECASE
)

_OBJ = r"(?!you\b|me\b)[\w' ]{1,40}?"
_NOT_YOU = r"(?!you\b|me\b)"
_TELL_PAST = r"(?:told|alerted|notified|informed|messaged|texted|contacted|called)"
_TELL_ING = (
    r"(?:telling|alerting|notifying|informing|messaging|texting|contacting|calling)"
)
_TELL = r"(?:tell|alert|notify|inform|message|text|contact|call)"

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

_TOLD_PASSIVE: Final = re.compile(
    r"\b(?:has|have) been (?:told|notified|alerted|informed)\b", re.IGNORECASE
)

_TOLD_SOON: Final = re.compile(
    r"\bI(?:'ll| will) (?:let " + _OBJ + r" know|" + _TELL + " " + _NOT_YOU + ")",
    re.IGNORECASE,
)

_SELF_ACTION: Final = re.compile(
    r"\bI(?:'m| am|'ll| will|'ve| have)(?: going to)? (?:call|calling|called|send|sending|sent)\b",
    re.IGNORECASE,
)

_PROMISE: Final = re.compile(
    r"\bon (?:the|her|his|their|its) way\b"
    r"|\b(?:is|are|'s|'re) coming\b"
    r"|(?:\bwill|'ll) (?:call|come|help|reach|get you|take you|be (?:there|here|with you|in touch|by))\b"
    r"|\bhelp is (?:coming|on)\b",
    re.IGNORECASE,
)

_QUOTED: Final = re.compile(
    r"\"[^\"]*\"|“[^”]*”"
    r"|\b(?:wrote|writes|says|said)\b[:,]?[^.!?]*",
    re.IGNORECASE,
)

_SAY_EXACTLY: Final = re.compile(r'Say exactly: "([^"]+)"')

_SAME_OR_ANOTHER_ASKED: Final = re.compile(r"\bsame one\b", re.IGNORECASE)

_SAID_ANOTHER: Final = re.compile(
    r"\b(?:another|a second|second one|one more|two more|different one)\b",
    re.IGNORECASE,
)
_SAID_SAME: Final = re.compile(r"\bsame\b", re.IGNORECASE)

_SENTENCE_END: Final = re.compile(r"(?<=[.!?])\s+")


def claims_family_told(text: str, told_before: bool = False) -> bool:
    own = _QUOTED.sub(" ", text)
    if _TOLD_NOW.search(own):
        return True
    if not told_before and _TOLD_PASSIVE.search(own):
        return True
    return "?" not in text and bool(_TOLD_SOON.search(own))


def _turn_outputs(chat_ctx: ChatContext) -> list[tuple[str, str]]:
    outputs: list[tuple[str, str]] = []
    for item in reversed(chat_ctx.items):
        if item.type == "message" and item.role == "user":
            break
        if item.type == "function_call_output":
            outputs.append((item.name, item.output))
    return outputs


def told_this_turn(chat_ctx: ChatContext) -> str | None:
    for name, output in _turn_outputs(chat_ctx):
        if name not in TOLD_TOOLS:
            continue
        for sentence in _SENTENCE_END.split(output.strip()):
            if _RESULT_SAYS_TOLD.search(sentence):
                return sentence
    return None


def _told_earlier(chat_ctx: ChatContext) -> bool:
    return any(
        item.type == "function_call_output"
        and item.name in TOLD_TOOLS
        and _RESULT_SAYS_TOLD.search(item.output)
        for item in chat_ctx.items
    )


def pending_dose_question(chat_ctx: ChatContext) -> str | None:
    outputs = _turn_outputs(chat_ctx)
    if not outputs or outputs[0][0] != "log_dose":
        return None
    if not outputs[0][1].startswith(SAME_OR_ANOTHER):
        return None
    match = _SAY_EXACTLY.search(outputs[0][1])
    return match.group(1) if match else None


def another_is_hers(chat_ctx: ChatContext) -> bool:
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
    kept = [
        sentence
        for sentence in _SENTENCE_END.split(text.strip())
        if sentence
        and not _SELF_ACTION.search(_QUOTED.sub(" ", sentence))
        and (US_EMERGENCY_NUMBER in sentence or not _PROMISE.search(sentence))
    ]
    return " ".join(kept)


def review_reply(text: str, chat_ctx: ChatContext) -> str | ForceFlag:
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
