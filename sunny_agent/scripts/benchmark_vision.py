# benchmark_vision.py
# Purpose: Benchmark latency of different vision model approaches for iOS screen
# description. Tests each approach against a real iPhone screenshot to measure
# time-to-first-token (where applicable) and total response time. The target task
# is detecting the "Apple Developer" app icon on an iOS home screen.
#
# Approaches tested:
#   1. Gemini 2.5 Flash — full structured JSON prompt (current production prompt)
#   2. Gemini 2.5 Flash — simple one-line prompt
#   3. Claude Haiku 4.5 — full structured JSON prompt
#   4. Claude Haiku 4.5 — simple one-line prompt
#   5. GPT-4o-mini — simple prompt (cheap/fast baseline)
#
# Usage:
#   cd sunny_agent
#   uv run scripts/benchmark_vision.py [--image PATH] [--runs N]
#
# Requires env vars: GOOGLE_API_KEY (or GEMINI_API_KEY), ANTHROPIC_API_KEY, OPENAI_API_KEY
#
# Last modified: 2026-03-03

from __future__ import annotations

import argparse
import asyncio
import base64
import statistics
import time
from pathlib import Path

from dotenv import load_dotenv

# Load .env from sunny_agent root (same as agent.py)
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

# ---------------------------------------------------------------------------
# Prompts
# ---------------------------------------------------------------------------

FULL_STRUCTURED_PROMPT = """\
Analyze this iOS screenshot and output JSON matching this exact schema:
{
  "current_app": "...",
  "current_screen": "...",
  "notable_elements": [{"label": "...", "position": "...", "state": "..."}],
  "target_visible": true|false|null,
  "target_description": "...",
  "target_position": "...",
  "step_complete": true|false|null,
  "unexpected_elements": ["..."]
}
target_visible and step_complete are null when no workflow is active.
Include ALL tappable/visible UI elements in notable_elements with label, \
position (e.g. "top left", "row 3", "bottom center"), and state \
(e.g. "enabled", "selected", "dimmed").
Output only valid JSON, no markdown code fences."""

SIMPLE_PROMPT = (
    "What app is shown and what screen is visible? "
    "List the app icons visible and their grid positions (row, column). "
    "Be concise."
)

TARGET_APP = "Developer"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def load_image(path: str) -> tuple[bytes, str]:
    """
    purpose: Load an image file and return (raw_bytes, base64_encoded_string).
    @param path: (str) Path to the image file.
    @return: (tuple) Raw bytes and base64-encoded string.
    """
    data = Path(path).read_bytes()
    b64 = base64.standard_b64encode(data).decode("utf-8")
    return data, b64


def print_result(name: str, latencies: list[float], response_text: str) -> None:
    """
    purpose: Print benchmark results for a single approach.
    @param name: (str) Name of the approach.
    @param latencies: (list[float]) List of latency measurements in seconds.
    @param response_text: (str) The model's response text (last run).
    """
    found = TARGET_APP.lower() in response_text.lower()
    avg = statistics.mean(latencies)
    med = statistics.median(latencies)
    mn = min(latencies)
    mx = max(latencies)
    print(f"\n{'=' * 60}")
    print(f"  {name}")
    print(f"{'=' * 60}")
    print(f"  Runs:    {len(latencies)}")
    print(f"  Avg:     {avg:.2f}s")
    print(f"  Median:  {med:.2f}s")
    print(f"  Min:     {mn:.2f}s")
    print(f"  Max:     {mx:.2f}s")
    print(f"  Target '{TARGET_APP}' detected: {'YES' if found else 'NO'}")
    print(f"  Response preview: {response_text[:200]}...")


# ---------------------------------------------------------------------------
# Benchmark runners
# ---------------------------------------------------------------------------


async def bench_gemini(
    image_bytes: bytes,
    prompt: str,
    runs: int,
    label: str,
    model: str = "gemini-2.5-flash",
) -> tuple[list[float], str]:
    """
    purpose: Benchmark Google Gemini vision API with a configurable model.
    @param image_bytes: (bytes) Raw JPEG bytes.
    @param prompt: (str) Text prompt to send with the image.
    @param runs: (int) Number of iterations.
    @param label: (str) Display label for progress output.
    @param model: (str) Gemini model ID. Defaults to gemini-2.5-flash.
    @return: (tuple) List of latencies and last response text.
    """
    import google.genai as genai

    client = genai.Client()
    latencies: list[float] = []
    last_text = ""

    for i in range(runs):
        contents: list[genai.types.Part | str] = [
            genai.types.Part.from_bytes(data=image_bytes, mime_type="image/jpeg"),
            prompt,
        ]
        t0 = time.perf_counter()
        response = await client.aio.models.generate_content(
            model=model,
            contents=contents,  # type: ignore[arg-type]
            config=genai.types.GenerateContentConfig(
                automatic_function_calling=genai.types.AutomaticFunctionCallingConfig(
                    disable=True,
                ),
            ),
        )
        elapsed = time.perf_counter() - t0
        latencies.append(elapsed)
        last_text = str(response.text)
        print(f"  [{label}] run {i + 1}/{runs}: {elapsed:.2f}s")

    return latencies, last_text


async def bench_claude(
    image_b64: str, prompt: str, runs: int, label: str, model: str
) -> tuple[list[float], str]:
    """
    purpose: Benchmark Anthropic Claude vision API (non-streaming, total latency).
    @param image_b64: (str) Base64-encoded JPEG string.
    @param prompt: (str) Text prompt to send with the image.
    @param runs: (int) Number of iterations.
    @param label: (str) Display label for progress output.
    @param model: (str) Anthropic model ID.
    @return: (tuple) List of latencies and last response text.
    """
    import anthropic

    client = anthropic.AsyncAnthropic()
    latencies: list[float] = []
    last_text = ""

    for i in range(runs):
        t0 = time.perf_counter()
        response = await client.messages.create(
            model=model,
            max_tokens=1024,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": "image/jpeg",
                                "data": image_b64,
                            },
                        },
                        {"type": "text", "text": prompt},
                    ],
                }
            ],
        )
        elapsed = time.perf_counter() - t0
        latencies.append(elapsed)
        last_text = response.content[0].text  # type: ignore[union-attr]
        print(f"  [{label}] run {i + 1}/{runs}: {elapsed:.2f}s")

    return latencies, last_text


async def bench_claude_streaming(
    image_b64: str, prompt: str, runs: int, label: str, model: str
) -> tuple[list[float], list[float], str]:
    """
    purpose: Benchmark Anthropic Claude vision API with streaming to measure TTFT
             separately from total latency.
    @param image_b64: (str) Base64-encoded JPEG string.
    @param prompt: (str) Text prompt to send with the image.
    @param runs: (int) Number of iterations.
    @param label: (str) Display label for progress output.
    @param model: (str) Anthropic model ID.
    @return: (tuple) List of TTFT latencies, total latencies, and last response text.
    """
    import anthropic

    client = anthropic.AsyncAnthropic()
    ttft_latencies: list[float] = []
    total_latencies: list[float] = []
    last_text = ""

    for i in range(runs):
        t0 = time.perf_counter()
        ttft_recorded = False
        chunks: list[str] = []

        async with client.messages.stream(
            model=model,
            max_tokens=1024,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": "image/jpeg",
                                "data": image_b64,
                            },
                        },
                        {"type": "text", "text": prompt},
                    ],
                }
            ],
        ) as stream:
            async for text in stream.text_stream:
                if not ttft_recorded:
                    ttft_latencies.append(time.perf_counter() - t0)
                    ttft_recorded = True
                chunks.append(text)

        total = time.perf_counter() - t0
        total_latencies.append(total)
        last_text = "".join(chunks)
        ttft = ttft_latencies[-1] if ttft_recorded else total
        print(f"  [{label}] run {i + 1}/{runs}: TTFT={ttft:.2f}s total={total:.2f}s")

    return ttft_latencies, total_latencies, last_text


async def bench_openai(
    image_b64: str, prompt: str, runs: int, label: str, model: str
) -> tuple[list[float], str]:
    """
    purpose: Benchmark OpenAI vision API (non-streaming, total latency).
    @param image_b64: (str) Base64-encoded JPEG string.
    @param prompt: (str) Text prompt to send with the image.
    @param runs: (int) Number of iterations.
    @param label: (str) Display label for progress output.
    @param model: (str) OpenAI model ID.
    @return: (tuple) List of latencies and last response text.
    """
    import openai

    client = openai.AsyncOpenAI()
    latencies: list[float] = []
    last_text = ""

    for i in range(runs):
        t0 = time.perf_counter()
        response = await client.chat.completions.create(
            model=model,
            max_tokens=1024,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:image/jpeg;base64,{image_b64}",
                                "detail": "low",
                            },
                        },
                        {"type": "text", "text": prompt},
                    ],
                }
            ],
        )
        elapsed = time.perf_counter() - t0
        latencies.append(elapsed)
        last_text = response.choices[0].message.content or ""
        print(f"  [{label}] run {i + 1}/{runs}: {elapsed:.2f}s")

    return latencies, last_text


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


async def main() -> None:
    """
    purpose: Parse CLI args, load the image, run all benchmarks, and print a
             comparison summary table.
    """
    parser = argparse.ArgumentParser(description="Vision latency benchmark")
    parser.add_argument(
        "--image",
        default=str(Path(__file__).resolve().parent.parent.parent / "screenshot.jpeg"),
        help="Path to test screenshot",
    )
    parser.add_argument("--runs", type=int, default=3, help="Runs per approach")
    args = parser.parse_args()

    image_bytes, image_b64 = load_image(args.image)
    print(f"Image: {args.image} ({len(image_bytes)} bytes)")
    print(f"Runs per approach: {args.runs}\n")

    results: list[dict] = []

    # 1. Gemini 2.5 Flash Lite — simple prompt (non-thinking, pure speed)
    print("--- Gemini 2.5 Flash Lite (simple) ---")
    lats, text = await bench_gemini(
        image_bytes,
        SIMPLE_PROMPT,
        args.runs,
        "flash-lite-simple",
        "gemini-2.5-flash-lite",
    )
    print_result("Gemini 2.5 Flash Lite (simple)", lats, text)
    results.append(
        {
            "name": "Flash Lite (simple)",
            "avg": statistics.mean(lats),
            "med": statistics.median(lats),
            "min": min(lats),
            "found": TARGET_APP.lower() in text.lower(),
        }
    )

    # 2. Gemini 2.5 Flash Lite — full structured prompt
    print("\n--- Gemini 2.5 Flash Lite (full structured) ---")
    lats, text = await bench_gemini(
        image_bytes,
        FULL_STRUCTURED_PROMPT,
        args.runs,
        "flash-lite-full",
        "gemini-2.5-flash-lite",
    )
    print_result("Gemini 2.5 Flash Lite (full structured)", lats, text)
    results.append(
        {
            "name": "Flash Lite (full)",
            "avg": statistics.mean(lats),
            "med": statistics.median(lats),
            "min": min(lats),
            "found": TARGET_APP.lower() in text.lower(),
        }
    )

    # 3. Gemini 3.1 Flash Lite — simple prompt (newest, fastest)
    print("\n--- Gemini 3.1 Flash Lite (simple) ---")
    lats, text = await bench_gemini(
        image_bytes,
        SIMPLE_PROMPT,
        args.runs,
        "3.1-lite-simple",
        "gemini-3.1-flash-lite-preview",
    )
    print_result("Gemini 3.1 Flash Lite (simple)", lats, text)
    results.append(
        {
            "name": "3.1 Flash Lite (simple)",
            "avg": statistics.mean(lats),
            "med": statistics.median(lats),
            "min": min(lats),
            "found": TARGET_APP.lower() in text.lower(),
        }
    )

    # 4. Gemini 2.5 Flash — full structured prompt (current production)
    print("\n--- Gemini 2.5 Flash (full structured) ---")
    lats, text = await bench_gemini(
        image_bytes,
        FULL_STRUCTURED_PROMPT,
        args.runs,
        "gemini-2.5-full",
        "gemini-2.5-flash",
    )
    print_result("Gemini 2.5 Flash (full structured)", lats, text)
    results.append(
        {
            "name": "Gemini 2.5 Flash (full)",
            "avg": statistics.mean(lats),
            "med": statistics.median(lats),
            "min": min(lats),
            "found": TARGET_APP.lower() in text.lower(),
        }
    )

    # 5. Gemini 2.5 Flash — simple prompt
    print("\n--- Gemini 2.5 Flash (simple) ---")
    lats, text = await bench_gemini(
        image_bytes, SIMPLE_PROMPT, args.runs, "gemini-2.5-simple", "gemini-2.5-flash"
    )
    print_result("Gemini 2.5 Flash (simple)", lats, text)
    results.append(
        {
            "name": "Gemini 2.5 Flash (simple)",
            "avg": statistics.mean(lats),
            "med": statistics.median(lats),
            "min": min(lats),
            "found": TARGET_APP.lower() in text.lower(),
        }
    )

    # 6. Claude Haiku 4.5 — streaming (TTFT + total)
    print("\n--- Claude Haiku 4.5 (simple, streaming) ---")
    ttft_lats, total_lats, text = await bench_claude_streaming(
        image_b64,
        SIMPLE_PROMPT,
        args.runs,
        "haiku-simple-stream",
        "claude-haiku-4-5-20251001",
    )
    print_result("Claude Haiku 4.5 (simple, streaming)", total_lats, text)
    results.append(
        {
            "name": "Haiku (simple, stream)",
            "avg": statistics.mean(total_lats),
            "med": statistics.median(total_lats),
            "min": min(total_lats),
            "ttft_avg": statistics.mean(ttft_lats),
            "found": TARGET_APP.lower() in text.lower(),
        }
    )

    # 7. Claude Haiku 4.5 — full structured prompt, streaming
    print("\n--- Claude Haiku 4.5 (full structured, streaming) ---")
    ttft_lats, total_lats, text = await bench_claude_streaming(
        image_b64,
        FULL_STRUCTURED_PROMPT,
        args.runs,
        "haiku-full-stream",
        "claude-haiku-4-5-20251001",
    )
    print_result("Claude Haiku 4.5 (full structured, streaming)", total_lats, text)
    results.append(
        {
            "name": "Haiku (full, stream)",
            "avg": statistics.mean(total_lats),
            "med": statistics.median(total_lats),
            "min": min(total_lats),
            "ttft_avg": statistics.mean(ttft_lats),
            "found": TARGET_APP.lower() in text.lower(),
        }
    )

    # 8. GPT-4o-mini — simple prompt
    print("\n--- GPT-4o-mini (simple) ---")
    lats, text = await bench_openai(
        image_b64, SIMPLE_PROMPT, args.runs, "4o-mini-simple", "gpt-4o-mini"
    )
    print_result("GPT-4o-mini (simple)", lats, text)
    results.append(
        {
            "name": "GPT-4o-mini (simple)",
            "avg": statistics.mean(lats),
            "med": statistics.median(lats),
            "min": min(lats),
            "found": TARGET_APP.lower() in text.lower(),
        }
    )

    # Summary table
    print(f"\n\n{'=' * 75}")
    print("  SUMMARY — Sorted by median latency")
    print(f"{'=' * 75}")
    print(
        f"  {'Approach':<30} {'Avg':>7} {'Med':>7} {'Min':>7} {'TTFT':>7} {'Found':>6}"
    )
    print(f"  {'-' * 30} {'-' * 7} {'-' * 7} {'-' * 7} {'-' * 7} {'-' * 6}")
    for r in sorted(results, key=lambda x: x["med"]):
        ttft_str = f"{r['ttft_avg']:.2f}s" if "ttft_avg" in r else "  n/a"
        found_str = "YES" if r["found"] else "NO"
        print(
            f"  {r['name']:<30} {r['avg']:>6.2f}s {r['med']:>6.2f}s "
            f"{r['min']:>6.2f}s {ttft_str:>7} {found_str:>6}"
        )
    print()


if __name__ == "__main__":
    asyncio.run(main())
