# screen_capture.py
# Purpose: Screen share frame capture for the Sunny voice agent.
# Subscribes to a LiveKit video track (iOS broadcast extension screen share),
# reads frames in a background asyncio task, and stores the latest changed frame
# as JPEG bytes. On each accepted frame, fires an _on_frame_captured callback
# (SCREEN-9: event-driven push to ScreenDescriber, replacing the poll loop).
#
# Change detection uses a 64-bit perceptual hash (average hash). Frames whose
# Hamming distance from the previous accepted frame exceeds HAMMING_THRESHOLD
# are stored; identical or near-identical frames are discarded to avoid flooding
# the LLM with redundant images. Additionally, time-based throttling (SCREEN-5)
# limits accepted frames to at most one every MIN_FRAME_INTERVAL_S seconds,
# preventing scroll-heavy UI interactions from flooding the vision LLM.
#
# No LLM calls are made here — this module is pure plumbing: track subscription,
# frame capture, change detection, and JPEG encoding.
#
# I420 support added: ReplayKit on iOS delivers frames in I420 (YUV 4:2:0 planar)
# format. _i420_to_pil() converts using BT.601 full-range YCbCr->RGB coefficients.
#
# Efficiency notes:
#   - frame.data is passed directly to PIL/numpy without copying via bytes().
#   - _i420_to_pil uses np.frombuffer with offset/count to avoid slice copies.
#   - _compute_hash has an I420 fast-path: reads Y plane directly as grayscale,
#     skipping the full YUV->RGB->L round-trip (~50-70% faster for iOS frames).
#
# SCREEN-7: Added last_frame_change_time property to detect staleness.
#           Added small-frame guard to skip 8x8 termination frames from iOS.
# SCREEN-9: Replaced _frame_changed flag / peek_frame_changed / consume_frame_bytes
#           with _on_frame_captured callback pushed synchronously from _read_frames.
#
# Last modified: 2026-03-03

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable
from io import BytesIO

import numpy as np
from livekit import rtc
from PIL import Image

logger = logging.getLogger("screen_capture")

HASH_SIZE = 8  # 8x8 grid -> 64-bit perceptual hash
HAMMING_THRESHOLD = 5  # Hamming distance > this -> frame is "changed"
JPEG_QUALITY = 70
MAX_DIMENSION = 1024  # thumbnail fits within 1024x1024, preserving aspect ratio
# (portrait iPhone ~473x1024 - sufficient for LLM visual analysis)
MIN_FRAME_INTERVAL_S = 0.5  # minimum seconds between accepted frames


def _i420_to_pil(data: bytes, width: int, height: int) -> Image.Image:
    """
    purpose: Convert a planar I420 (YUV 4:2:0) byte buffer to a PIL RGB Image.
             I420 layout: Y plane (width x height), U plane (w/2 x h/2), V plane (w/2 x h/2).
             Applies BT.601 full-range YCbCr->RGB coefficients.
             This is the native format delivered by the iOS ReplayKit broadcast extension.
             Uses np.frombuffer with offset/count to read planes without slice copies.
    @param data: (bytes) Raw I420 byte buffer.
    @param width: (int) Frame width in pixels.
    @param height: (int) Frame height in pixels.
    @return: (Image.Image) PIL Image in RGB mode.
    """
    y_size = width * height
    uv_w, uv_h = width // 2, height // 2
    uv_size = uv_w * uv_h

    y = np.frombuffer(data, dtype=np.uint8, count=y_size).reshape((height, width))
    u = np.frombuffer(data, dtype=np.uint8, count=uv_size, offset=y_size).reshape(
        (uv_h, uv_w)
    )
    v = np.frombuffer(
        data, dtype=np.uint8, count=uv_size, offset=y_size + uv_size
    ).reshape((uv_h, uv_w))

    # Upsample chroma planes to luma size via nearest-neighbour repeat
    u = np.repeat(np.repeat(u, 2, axis=0), 2, axis=1)
    v = np.repeat(np.repeat(v, 2, axis=0), 2, axis=1)

    # BT.601 full-range YCbCr → RGB
    y_f = y.astype(np.float32)
    u_f = u.astype(np.float32) - 128.0
    v_f = v.astype(np.float32) - 128.0

    r = np.clip(y_f + 1.402 * v_f, 0, 255).astype(np.uint8)
    g = np.clip(y_f - 0.344136 * u_f - 0.714136 * v_f, 0, 255).astype(np.uint8)
    b = np.clip(y_f + 1.772 * u_f, 0, 255).astype(np.uint8)

    return Image.fromarray(np.stack([r, g, b], axis=2))


def _frame_to_pil(frame: rtc.VideoFrame) -> Image.Image:
    """
    purpose: Convert a LiveKit VideoFrame to a PIL Image.
             Handles RGBA, BGRA (swaps R/B channels), RGB24, I420, and I420A buffer types.
             I420/I420A are the formats sent by the iOS ReplayKit broadcast extension.
             frame.data is passed directly (no bytes() copy).
    @param frame: (rtc.VideoFrame) The raw video frame from the LiveKit stream.
    @return: (Image.Image) PIL Image in RGB or RGBA mode.
    @raises ValueError: If the VideoBufferType is not supported.
    """
    buf_type = frame.type
    width, height = frame.width, frame.height

    if buf_type == rtc.VideoBufferType.RGBA:
        return Image.frombytes("RGBA", (width, height), frame.data)
    elif buf_type == rtc.VideoBufferType.BGRA:
        img = Image.frombytes("RGBA", (width, height), frame.data)
        r, g, b, a = img.split()
        return Image.merge("RGBA", (b, g, r, a))
    elif buf_type == rtc.VideoBufferType.RGB24:
        return Image.frombytes("RGB", (width, height), frame.data)
    elif buf_type in (rtc.VideoBufferType.I420, rtc.VideoBufferType.I420A):
        # I420A appends an alpha plane after the I420 planes; ignore alpha for JPEG output
        return _i420_to_pil(frame.data, width, height)
    else:
        raise ValueError(f"Unsupported VideoBufferType: {buf_type}")


def _compute_hash(frame: rtc.VideoFrame) -> int:
    """
    purpose: Compute a 64-bit perceptual (average) hash for a video frame.
             Converts to grayscale, resizes to HASH_SIZE x HASH_SIZE, then sets
             each bit to 1 if the pixel is >= the mean, else 0.
             For I420/I420A frames, extracts the Y (luma) plane directly instead
             of converting to RGB then back to grayscale (~50-70% faster).
    @param frame: (rtc.VideoFrame) The raw video frame to hash.
    @return: (int) 64-bit integer perceptual hash.
    """
    if frame.type in (rtc.VideoBufferType.I420, rtc.VideoBufferType.I420A):
        # Fast path: Y plane is already luma (grayscale); skip YUV→RGB→L round-trip.
        y_size = frame.width * frame.height
        y = np.frombuffer(frame.data, dtype=np.uint8, count=y_size).reshape(
            (frame.height, frame.width)
        )
        img: Image.Image = Image.fromarray(y)
    else:
        img = _frame_to_pil(frame).convert("L")
    img = img.resize((HASH_SIZE, HASH_SIZE), Image.Resampling.LANCZOS)
    pixels = list(img.getdata())
    mean = sum(pixels) / len(pixels)
    bits = [1 if p >= mean else 0 for p in pixels]
    return sum(bit << i for i, bit in enumerate(bits))


def _hamming_distance(a: int, b: int) -> int:
    """
    purpose: Compute the Hamming distance between two integers interpreted as bit vectors.
    @param a: (int) First hash value.
    @param b: (int) Second hash value.
    @return: (int) Number of bit positions that differ.
    """
    return bin(a ^ b).count("1")


def _encode_frame(frame: rtc.VideoFrame) -> bytes:
    """
    purpose: Encode a video frame as a JPEG byte string, scaled to fit within
             MAX_DIMENSION x MAX_DIMENSION while preserving aspect ratio.
             Alpha channel is dropped (JPEG does not support transparency).
    @param frame: (rtc.VideoFrame) The raw video frame to encode.
    @return: (bytes) JPEG-encoded image bytes.
    """
    img = _frame_to_pil(frame)
    img.thumbnail((MAX_DIMENSION, MAX_DIMENSION), Image.Resampling.LANCZOS)
    img = img.convert("RGB")
    buf = BytesIO()
    img.save(buf, format="JPEG", quality=JPEG_QUALITY)
    return buf.getvalue()


class ScreenCapture:
    """
    purpose: Manages subscription to a LiveKit video track representing an iOS
             screen share (from the broadcast extension). Reads frames in a
             background asyncio task and stores the latest changed frame as JPEG
             bytes. On each accepted frame, the _on_frame_captured callback is
             invoked synchronously from _read_frames so ScreenDescriber can react
             immediately without polling (SCREEN-9: event-driven push).

             Change detection uses a 64-bit perceptual hash; frames within
             HAMMING_THRESHOLD bits of the previous accepted frame are discarded.
    """

    def __init__(self) -> None:
        """
        purpose: Initialize ScreenCapture with all state set to idle/empty.
        """
        self._on_frame_captured: Callable[[bytes], None] | None = None
        self._prev_hash: int | None = None
        self._video_stream: rtc.VideoStream | None = None
        self._read_task: asyncio.Task[None] | None = None
        self._last_frame_change_time: float = 0.0

    @property
    def has_active_stream(self) -> bool:
        """
        purpose: Return True if a video stream is currently active.
        @return: (bool) True when a stream and read task are running.
        """
        return self._video_stream is not None

    @property
    def last_frame_change_time(self) -> float:
        """
        purpose: Return the monotonic timestamp of the last accepted (changed) frame.
                 Allows callers to detect screen staleness without consuming the frame.
        @return: (float) time.monotonic() value of the last accepted frame, or 0.0
                 if no frame has been accepted yet.
        """
        return self._last_frame_change_time

    def set_on_frame_captured(self, callback: Callable[[bytes], None] | None) -> None:
        """
        purpose: Register (or clear) a callback invoked with fresh JPEG bytes every time
                 a changed frame is accepted. Used by ScreenDescriber to replace polling
                 (SCREEN-9: event-driven push replaces peek_frame_changed poll loop).
        @param callback: (Callable | None) Called synchronously from _read_frames task.
                         Pass None to unregister.
        """
        self._on_frame_captured = callback

    def start_capture(self, track: rtc.Track) -> None:
        """
        purpose: Begin capturing frames from the given LiveKit video track.
                 Stops any existing capture before starting a new one.
        @param track: (rtc.Track) The remote video track to subscribe to.
        """
        self.stop_capture()
        self._video_stream = rtc.VideoStream(track)
        self._read_task = asyncio.create_task(self._read_frames())

    def stop_capture(self) -> None:
        """
        purpose: Stop the frame capture loop and release all resources.
                 Safe to call on a fresh instance or multiple times.
        """
        if self._read_task is not None:
            self._read_task.cancel()
            self._read_task = None
        if self._video_stream is not None:
            stream = self._video_stream
            self._video_stream = None

            async def _safe_aclose() -> None:
                try:
                    await stream.aclose()
                except Exception:
                    logger.warning("VideoStream.aclose() raised during stop_capture")

            asyncio.create_task(_safe_aclose())  # noqa: RUF006
        self._prev_hash = None
        self._last_frame_change_time = 0.0

    async def _read_frames(self) -> None:
        """
        purpose: Background asyncio task that reads frames from the video stream,
                 computes perceptual hashes, and on each changed frame: encodes it as
                 JPEG, updates _last_frame_change_time, and calls _on_frame_captured.
                 Frames are throttled to at most one every MIN_FRAME_INTERVAL_S seconds.
                 Skips frames smaller than 32x32 pixels (the iOS broadcast extension
                 sends an 8x8 termination frame on session end that passes hash detection).
                 Exits cleanly on CancelledError. Logs and exits on other exceptions
                 to avoid crashing the agent session.
        """
        try:
            if self._video_stream is None:
                return
            last_accepted = 0.0
            async for event in self._video_stream:
                frame = event.frame
                now = time.monotonic()
                if now - last_accepted < MIN_FRAME_INTERVAL_S:
                    continue
                # Skip termination frames — iOS broadcast extension sends an 8x8 frame
                # on session end that has a different hash and would corrupt the cache.
                if frame.width < 32 or frame.height < 32:
                    logger.debug(
                        "Skipping undersized frame (%dx%d)",
                        frame.width,
                        frame.height,
                    )
                    continue
                h = _compute_hash(frame)
                if (
                    self._prev_hash is None
                    or _hamming_distance(h, self._prev_hash) > HAMMING_THRESHOLD
                ):
                    frame_bytes = _encode_frame(frame)
                    self._prev_hash = h
                    self._last_frame_change_time = now
                    last_accepted = now
                    logger.info(
                        "Frame captured (%d bytes, %dx%d)",
                        len(frame_bytes),
                        frame.width,
                        frame.height,
                    )
                    if self._on_frame_captured is not None:
                        self._on_frame_captured(frame_bytes)
        except asyncio.CancelledError:
            pass
        except Exception:
            logger.exception("Error in _read_frames; stopping capture")
