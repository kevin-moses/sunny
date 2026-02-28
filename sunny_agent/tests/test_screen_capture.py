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
#   - ScreenCapture state: initial None, flag-reset semantics, stop_capture cleanup
#
# Last modified: 2026-02-28 (consume_frame_bytes rename)

from livekit import rtc

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


def test_hamming_distance_identical():
    """_hamming_distance(x, x) must always be 0."""
    for x in (0, 1, 0xFFFFFFFF, 0xDEADBEEF):
        assert _hamming_distance(x, x) == 0


def test_hamming_distance_known():
    """0b0101 XOR 0b1010 = 0b1111 → 4 bits set."""
    assert _hamming_distance(0b0101, 0b1010) == 4


# ---------------------------------------------------------------------------
# _compute_hash tests
# ---------------------------------------------------------------------------


def test_compute_hash_deterministic():
    """The same frame must produce the same hash on two independent calls."""
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


def test_compute_hash_different_colors():
    """Frames with inverted halves must produce different perceptual hashes.

    Solid-color images always produce all-1s hashes (every pixel equals the mean),
    so this test uses spatially varying frames to exercise meaningful differentiation.
    """
    white_top = _make_half_white_half_black_rgba_frame(64, 64)
    black_top = _make_half_black_half_white_rgba_frame(64, 64)
    assert _compute_hash(white_top) != _compute_hash(black_top)


# ---------------------------------------------------------------------------
# _encode_frame tests
# ---------------------------------------------------------------------------


def test_encode_frame_returns_jpeg():
    """Encoded output must start with the JPEG SOI marker (0xFF 0xD8)."""
    frame = _make_rgba_frame(64, 64, 200, 100, 50)
    data = _encode_frame(frame)
    assert data[:2] == b"\xff\xd8"


def test_encode_frame_within_max_dim():
    """Decoding the encoded output must produce an image within MAX_DIMENSION on each axis."""
    from io import BytesIO

    from PIL import Image

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


def test_i420_to_pil_returns_rgb():
    """_i420_to_pil must return an RGB image with the correct dimensions."""
    from PIL import Image

    width, height = 64, 48
    img = _i420_to_pil(
        bytes([128] * width * height + [128] * (width // 2) * (height // 2) * 2),
        width,
        height,
    )
    assert isinstance(img, Image.Image)
    assert img.mode == "RGB"
    assert img.size == (width, height)


def test_i420_frame_hashable():
    """_compute_hash must not raise for I420 frames (the format from ReplayKit)."""
    frame = _make_i420_frame(64, 48, y_val=128, u_val=128, v_val=128)
    h = _compute_hash(frame)
    assert isinstance(h, int)


def test_i420_frame_encodable():
    """_encode_frame must not raise for I420 frames and must return JPEG bytes."""
    frame = _make_i420_frame(64, 48, y_val=200, u_val=100, v_val=150)
    data = _encode_frame(frame)
    assert data[:2] == b"\xff\xd8"


# ---------------------------------------------------------------------------
# ScreenCapture state machine tests
# ---------------------------------------------------------------------------


def test_consume_returns_none_initially():
    """A freshly created ScreenCapture must return None before any frame arrives."""
    sc = ScreenCapture()
    assert sc.consume_frame_bytes() is None


def test_consume_resets_changed_flag():
    """consume_frame_bytes() returns bytes on first call, then None (flag reset)."""
    sc = ScreenCapture()
    # Inject state directly to bypass the async capture loop
    sc._latest_frame_bytes = b"fake-jpeg"
    sc._frame_changed = True

    first = sc.consume_frame_bytes()
    assert first == b"fake-jpeg"
    # Second call: flag was reset, should return None
    assert sc.consume_frame_bytes() is None


def test_stop_capture_clears_state():
    """stop_capture() must reset all state and report has_active_stream == False."""
    sc = ScreenCapture()
    sc._latest_frame_bytes = b"something"
    sc._frame_changed = True
    sc._prev_hash = 42

    sc.stop_capture()

    assert not sc.has_active_stream
    assert sc.consume_frame_bytes() is None
    assert sc._prev_hash is None
    assert not sc._frame_changed
