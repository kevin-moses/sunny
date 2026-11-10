# config.py
# Purpose: Shared constants and configuration values for the Sunny voice agent.
# Contains voice UX parameters tuned for senior users, model identifiers, and
# other values referenced across agent, memory, and prompt modules.
# Memory-care pivot: removed workflow retrieval (EMBEDDING_MODEL,
# WORKFLOW_MATCH_THRESHOLD) and screen describer constants (DESCRIBE_*,
# SCREEN_STALE_THRESHOLD_S) along with the features that used them.
# Removed FALLBACK_USER_ID: sessions resolve a household (DEV_HOUSEHOLD_ID env for local dev).
# Added DEFAULT_TIMEZONE, used only when no household context is available.
# Voice agent spec (2026-11-09): TTS_MODEL and TTS_SPEED (slow speech, a spec guardrail: the
# Cartesia plugin applies a float speed only on sonic-3, 0.6 to 2.0, 1.0 normal),
# INACTIVITY_TIMEOUT_S (the worker ends a session nobody speaks in, without relying on the
# display), and the post-call extraction's timeout and retries.
#
# Last modified: 2026-11-09

# Voice UX — tuned for senior speech patterns
MIN_ENDPOINTING_DELAY: float = 1.0  # seniors often pause mid-thought
MAX_ENDPOINTING_DELAY: float = 6.0
MIN_INTERRUPTION_DURATION: float = 1.0  # ignore brief sounds like coughs or TV
MIN_INTERRUPTION_WORDS: int = 2  # require 2+ words before treating as barge-in

# Fallback when a session has no household context (households always have a timezone).
DEFAULT_TIMEZONE = "America/New_York"

STT_MODEL = "nova-3"
STT_LANGUAGE = "multi"
LLM_MODEL = "claude-haiku-4-5-20251001"
TTS_VOICE = "1db9bd26-cac5-41dd-bf8d-0988d1f4eb03"
TTS_MODEL = "sonic-3"
TTS_SPEED: float = 0.85  # slower than normal (1.0) for an older listener
SUMMARY_MODEL = "claude-haiku-4-5-20251001"
SUMMARY_MAX_TOKENS = 1024
SUMMARY_TIMEOUT_S: float = 20.0  # per attempt of the post-call extraction
SUMMARY_ATTEMPTS = 2  # one retry

# A session with no speech from either side for this long is ended by the worker.
INACTIVITY_TIMEOUT_S: float = 60.0
INACTIVITY_CHECK_S: float = 5.0

# Echo detection window — how long to keep agent speech text for echo comparison.
# Must exceed max TTS audio duration (~10-15s).
ECHO_DETECTION_WINDOW_S: float = 15.0
