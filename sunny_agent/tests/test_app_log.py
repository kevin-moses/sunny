import json
import logging

import pytest
from livekit import rtc

from agent import APP_LOG_TOPIC, _forward_app_log


@pytest.fixture(autouse=True)
def _capture_debug(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level("DEBUG")


def _packet(data: bytes, topic: str | None = APP_LOG_TOPIC) -> rtc.DataPacket:
    return rtc.DataPacket(
        data=data, kind=rtc.DataPacketKind.KIND_LOSSY, participant=None, topic=topic
    )


def _entry(**overrides: object) -> bytes:
    payload: dict[str, object] = {
        "ts": "2026-11-15T12:00:00.000Z",
        "level": "WARNING",
        "component": "today",
        "message": "queue is stuck",
        "metadata": {"pending": 2},
    }
    payload.update(overrides)
    return json.dumps(payload).encode()


def _app_records(caplog: pytest.LogCaptureFixture) -> list[logging.LogRecord]:
    return [r for r in caplog.records if r.name.startswith("ios.")]


def _drop_warnings(caplog: pytest.LogCaptureFixture) -> list[str]:
    return [
        r.getMessage()
        for r in caplog.records
        if r.name == "agent" and r.levelname == "WARNING"
    ]


def test_valid_entry_is_logged_under_the_ios_namespace(
    caplog: pytest.LogCaptureFixture,
) -> None:
    _forward_app_log(_packet(_entry()))
    [record] = _app_records(caplog)
    assert record.name == "ios.today"
    assert record.levelname == "WARNING"
    assert record.getMessage() == "queue is stuck"
    assert record.__dict__["app"] == {"pending": 2}
    assert _drop_warnings(caplog) == []


def test_entry_without_metadata_logs_empty_metadata(
    caplog: pytest.LogCaptureFixture,
) -> None:
    payload = json.loads(_entry())
    del payload["metadata"]
    _forward_app_log(_packet(json.dumps(payload).encode()))
    [record] = _app_records(caplog)
    assert record.__dict__["app"] == {}


def test_unknown_level_logs_at_info(caplog: pytest.LogCaptureFixture) -> None:
    _forward_app_log(_packet(_entry(level="LOUD")))
    [record] = _app_records(caplog)
    assert record.levelname == "INFO"


@pytest.mark.parametrize(
    "data",
    [
        b"[1, 2]",
        b'"text"',
        b"42",
        b"null",
        b"{not json",
        b"",
        b"\xff\xfe",
        _entry(level=3),
        _entry(component=None),
        _entry(message=["a"]),
        _entry(metadata="x"),
    ],
)
def test_invalid_payload_is_dropped_with_one_warning(
    caplog: pytest.LogCaptureFixture, data: bytes
) -> None:
    _forward_app_log(_packet(data))
    assert _app_records(caplog) == []
    assert len(_drop_warnings(caplog)) == 1


def test_reserved_metadata_keys_are_kept_under_app(
    caplog: pytest.LogCaptureFixture,
) -> None:
    reserved = {
        "name": "n",
        "message": "m",
        "msg": "x",
        "args": [1],
        "module": "y",
        "created": 1,
    }
    _forward_app_log(_packet(_entry(metadata=reserved)))
    [record] = _app_records(caplog)
    assert record.getMessage() == "queue is stuck"
    assert record.__dict__["app"] == reserved


def test_other_topics_are_ignored(caplog: pytest.LogCaptureFixture) -> None:
    _forward_app_log(_packet(_entry(), topic="chat"))
    _forward_app_log(_packet(b"{not json", topic=None))
    assert _app_records(caplog) == []
    assert _drop_warnings(caplog) == []
