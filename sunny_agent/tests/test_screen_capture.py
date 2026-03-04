# test_screen_capture.py
# Purpose: Unit tests for screen_capture.py — covers all pure helper functions and
# the ScreenCapture state machine. No async networking or LiveKit server connections
# are required; synthetic VideoFrame objects are constructed directly from raw bytes.
#
# Test categories:
#   - _hamming_distance: identity, known bit-flip count
#   - _compute_hash: determinism, color sensitivity
#   - _encode_frame: JPEG output validation, MAX_DIMENSION constraint
#   - _i420_to_pil: I420 decoding (iOS ReplayKit native format)
#   - ScreenCapture state: callback wiring, stop_capture cleanup (SCREEN-9)
#   - _read_frames: integration path — changed frame fires _on_frame_captured (SCREEN-9)
#
# Last modified: 2026-03-03 (SCREEN-9: updated state tests + integration test)

from io import BytesIO

import pytest
from livekit import rtc
from PIL import Image

from screen_capture import (
    MAX_DIMENSION,
    ScreenCapture,
    _compute_hash,
    _encode_frame,
    _hamming_distance,
    _i420_to_pil,
)

# ---------------------------------------------------------------------------
# Synthetic frame factory
# ---------------------------------------------------------------------------


def _make_rgba_frame(width: int, height: int, r: int, g: int, b: int) -> rtc.VideoFrame:
    """
    purpose: Build a synthetic solid-color RGBA VideoFrame for testing.
    @param width: (int) Frame width in pixels.
    @param height: (int) Frame height in pixels.
    @param r: (int) Red channel value 0-255.
    @param g: (int) Green channel value 0-255.
    @param b: (int) Blue channel value 0-255.
    @return: (rtc.VideoFrame) Synthetic frame filled with the given color.
    """
    data = bytes([r, g, b, 255] * width * height)
    return rtc.VideoFrame(width, height, rtc.VideoBufferType.RGBA, data)


# ---------------------------------------------------------------------------
# _hamming_distance tests
# ---------------------------------------------------------------------------


def test_hamming_distance_identical() -> None:
    """
    purpose: Assert _hamming_distance returns 0 when both inputs are identical,
             for a range of values including edge cases (0, 1, max uint32, arbitrary).
    """
    for x in (0, 1, 0xFFFFFFFF, 0xDEADBEEF):
        assert _hamming_distance(x, x) == 0


def test_hamming_distance_known() -> None:
    """
    purpose: Assert _hamming_distance returns the correct count for a known pair:
             0b0101 XOR 0b1010 = 0b1111, which has 4 bits set.
    """
    assert _hamming_distance(0b0101, 0b1010) == 4


# ---------------------------------------------------------------------------
# _compute_hash tests
# ---------------------------------------------------------------------------


def test_compute_hash_deterministic() -> None:
    """
    purpose: Assert _compute_hash returns the same integer for the same frame
             on two independent calls (determinism).
    """
    frame = _make_rgba_frame(64, 64, 128, 64, 32)
    assert _compute_hash(frame) == _compute_hash(frame)


def _make_half_white_half_black_rgba_frame(width: int, height: int) -> rtc.VideoFrame:
    """
    purpose: Build an RGBA frame with white top half and black bottom half.
    @param width: (int) Frame width in pixels.
    @param height: (int) Frame height in pixels.
    @return: (rtc.VideoFrame) Synthetic frame with spatial variation.
    """
    top = bytes([255, 255, 255, 255] * width * (height // 2))
    bottom = bytes([0, 0, 0, 255] * width * (height - height // 2))
    return rtc.VideoFrame(width, height, rtc.VideoBufferType.RGBA, top + bottom)


def _make_half_black_half_white_rgba_frame(width: int, height: int) -> rtc.VideoFrame:
    """
    purpose: Build an RGBA frame with black top half and white bottom half.
    @param width: (int) Frame width in pixels.
    @param height: (int) Frame height in pixels.
    @return: (rtc.VideoFrame) Synthetic frame — inverse of _make_half_white_half_black.
    """
    top = bytes([0, 0, 0, 255] * width * (height // 2))
    bottom = bytes([255, 255, 255, 255] * width * (height - height // 2))
    return rtc.VideoFrame(width, height, rtc.VideoBufferType.RGBA, top + bottom)


def test_compute_hash_different_colors() -> None:
    """
    purpose: Assert spatially inverted frames produce different perceptual hashes.
             Solid-color frames all hash the same (every pixel equals the mean),
             so spatially varying frames are used to exercise differentiation.
    """
    white_top = _make_half_white_half_black_rgba_frame(64, 64)
    black_top = _make_half_black_half_white_rgba_frame(64, 64)
    assert _compute_hash(white_top) != _compute_hash(black_top)


# ---------------------------------------------------------------------------
# _encode_frame tests
# ---------------------------------------------------------------------------


def test_encode_frame_returns_jpeg() -> None:
    """
    purpose: Assert _encode_frame output starts with the JPEG SOI marker (0xFF 0xD8).
    """
    frame = _make_rgba_frame(64, 64, 200, 100, 50)
    data = _encode_frame(frame)
    assert data[:2] == b"\xff\xd8"


def test_encode_frame_within_max_dim() -> None:
    """
    purpose: Assert that encoding a large frame produces an image within
             MAX_DIMENSION on each axis (thumbnail path exercised).
    """
    # Use a large frame to exercise the thumbnail path
    frame = _make_rgba_frame(4096, 4096, 0, 128, 255)
    data = _encode_frame(frame)
    img = Image.open(BytesIO(data))
    assert img.width <= MAX_DIMENSION
    assert img.height <= MAX_DIMENSION


# ---------------------------------------------------------------------------
# _i420_to_pil tests (ReplayKit native format)
# ---------------------------------------------------------------------------


def _make_i420_frame(
    width: int, height: int, y_val: int, u_val: int, v_val: int
) -> rtc.VideoFrame:
    """
    purpose: Build a synthetic solid-color I420 VideoFrame for testing.
    @param width: (int) Frame width in pixels (should be even).
    @param height: (int) Frame height in pixels (should be even).
    @param y_val: (int) Y (luma) plane fill value 0-255.
    @param u_val: (int) U (Cb) plane fill value 0-255.
    @param v_val: (int) V (Cr) plane fill value 0-255.
    @return: (rtc.VideoFrame) Synthetic I420 frame.
    """
    y_plane = bytes([y_val] * width * height)
    u_plane = bytes([u_val] * (width // 2) * (height // 2))
    v_plane = bytes([v_val] * (width // 2) * (height // 2))
    return rtc.VideoFrame(
        width, height, rtc.VideoBufferType.I420, y_plane + u_plane + v_plane
    )


def test_i420_to_pil_returns_rgb() -> None:
    """
    purpose: Assert _i420_to_pil returns an RGB PIL Image with the correct dimensions.
    """
    width, height = 64, 48
    img = _i420_to_pil(
        bytes([128] * width * height + [128] * (width // 2) * (height // 2) * 2),
        width,
        height,
    )
    assert isinstance(img, Image.Image)
    assert img.mode == "RGB"
    assert img.size == (width, height)


def test_i420_frame_hashable() -> None:
    """
    purpose: Assert _compute_hash does not raise for I420 frames (the format
             delivered by the iOS ReplayKit broadcast extension).
    """
    frame = _make_i420_frame(64, 48, y_val=128, u_val=128, v_val=128)
    h = _compute_hash(frame)
    assert isinstance(h, int)


def test_i420_frame_encodable() -> None:
    """
    purpose: Assert _encode_frame does not raise for I420 frames and returns
             valid JPEG bytes starting with the SOI marker.
    """
    frame = _make_i420_frame(64, 48, y_val=200, u_val=100, v_val=150)
    data = _encode_frame(frame)
    assert data[:2] == b"\xff\xd8"


# ---------------------------------------------------------------------------
# ScreenCapture state machine tests (SCREEN-9: callback API)
# ---------------------------------------------------------------------------


def test_set_on_frame_captured_stores_callback() -> None:
    """
    purpose: set_on_frame_captured should store the callable on _on_frame_captured.
             Passing None should clear it without raising. Verifies SCREEN-9 API.
    """
    sc = ScreenCapture()
    captured: list[bytes] = []
    sc.set_on_frame_captured(lambda b: captured.append(b))
    assert sc._on_frame_captured is not None
    sc.set_on_frame_captured(None)
    assert sc._on_frame_captured is None


def test_stop_capture_clears_state() -> None:
    """
    purpose: stop_capture() must reset all frame state and report has_active_stream == False.
    """
    sc = ScreenCapture()
    sc._prev_hash = 42

    sc.stop_capture()

    assert not sc.has_active_stream
    assert sc._prev_hash is None


# ---------------------------------------------------------------------------
# _read_frames integration: changed frame fires _on_frame_captured (SCREEN-9)
# ---------------------------------------------------------------------------


class _FakeVideoStream:
    """
    purpose: Minimal async iterable that yields a fixed list of VideoFrameEvent objects,
             then stops. Used to drive _read_frames without a real LiveKit connection.
    """

    def __init__(self, events: list[rtc.VideoFrameEvent]) -> None:
        """
        purpose: Store the events to be yielded.
        @param events: (list[rtc.VideoFrameEvent]) Events to emit in order.
        """
        self._events = events

    def __aiter__(self) -> "_FakeVideoStream":
        """
        purpose: Return self as the async iterator.
        @return: (_FakeVideoStream) self.
        """
        self._iter = iter(self._events)
        return self

    async def __anext__(self) -> rtc.VideoFrameEvent:
        """
        purpose: Yield the next event or raise StopAsyncIteration when exhausted.
        @return: (rtc.VideoFrameEvent) Next event.
        @raises StopAsyncIteration: When all events have been yielded.
        """
        try:
            return next(self._iter)
        except StopIteration:
            raise StopAsyncIteration from None

    async def aclose(self) -> None:
        """
        purpose: No-op close for API compatibility with rtc.VideoStream.
        """


@pytest.mark.asyncio
async def test_read_frames_fires_callback_on_changed_frame() -> None:
    """
    purpose: Assert that _read_frames calls _on_frame_captured when a changed frame
             passes hash detection. Covers the core SCREEN-9 delivery path:
             frame arrives -> hash differs -> encode -> callback fires.
             Uses _FakeVideoStream to drive _read_frames without a real LiveKit server.
    """
    frame = _make_rgba_frame(64, 64, 100, 150, 200)
    event = rtc.VideoFrameEvent(
        frame=frame, timestamp_us=0, rotation=rtc.VideoRotation.VIDEO_ROTATION_0
    )

    sc = ScreenCapture()
    received: list[bytes] = []
    sc.set_on_frame_captured(lambda b: received.append(b))
    sc._video_stream = _FakeVideoStream([event])  # type: ignore[assignment]

    await sc._read_frames()

    assert len(received) == 1, (
        "Callback should have fired exactly once for the changed frame"
    )
    assert received[0][:2] == b"\xff\xd8", "Callback should receive valid JPEG bytes"
