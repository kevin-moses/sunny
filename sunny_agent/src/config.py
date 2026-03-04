# config.py
# Purpose: Shared constants and configuration values for the Sunny voice agent.
# Contains voice UX parameters tuned for senior users, model identifiers, and
# other values referenced across agent, memory, prompt, and workflow modules.
# Added EMBEDDING_MODEL and WORKFLOW_MATCH_THRESHOLD for WF-4 Supabase workflow retrieval.
# Added DESCRIBE_LLM_MODEL for the ScreenDescriber background Gemini calls.
# Added SCREEN_STALE_THRESHOLD_S and DESCRIBE_RATE_LIMIT_S for the hybrid
# router: Haiku handles all conversational turns; Gemini runs in the background.
# Added ECHO_DETECTION_WINDOW_S for SCREEN-7 agent self-interruption (echo) prevention.
# SCREEN-9: Removed PROACTIVE_MONITOR_INTERVAL_S (poll loop replaced by callback).
# Swapped DESCRIBE_LLM_MODEL to gemini-3.1-flash-lite-preview (~2s vs ~10-12s) and
# lowered DESCRIBE_RATE_LIMIT_S from 2.0 to 1.0 to match the faster model.
#
# Last modified: 2026-03-03

FALLBACK_USER_ID = "00000000-0000-0000-0000-000000000001"

# Voice UX — tuned for senior speech patterns
MIN_ENDPOINTING_DELAY: float = 1.0  # seniors often pause mid-thought
MAX_ENDPOINTING_DELAY: float = 6.0
MIN_INTERRUPTION_DURATION: float = 1.0  # ignore brief sounds like coughs or TV
MIN_INTERRUPTION_WORDS: int = 2  # require 2+ words before treating as barge-in

STT_MODEL = "nova-3"
STT_LANGUAGE = "multi"
LLM_MODEL = "claude-haiku-4-5-20251001"
TTS_VOICE = "1db9bd26-cac5-41dd-bf8d-0988d1f4eb03"
SUMMARY_MODEL = "claude-haiku-4-5-20251001"
SUMMARY_MAX_TOKENS = 1024

# Workflow semantic search (WF-4)
EMBEDDING_MODEL = "text-embedding-3-small"
# Minimum cosine similarity score to accept a workflow match (0.0-1.0)
WORKFLOW_MATCH_THRESHOLD: float = 0.5

# Background screen describer LLM — used only by ScreenDescriber for background Gemini
# calls. Assistant uses Claude Haiku (LLM_MODEL) for all conversational turns, keeping
# hot-path TTFT at 0.4-0.6s. Gemini runs in the background.
# Swapped from gemini-2.5-flash (~10-12s) to gemini-3.1-flash-lite-preview (~2s, 6x faster)
# with identical accuracy (benchmark confirmed). This enables rate limit reduction below.
DESCRIBE_LLM_MODEL = "gemini-3.1-flash-lite-preview"

# Staleness threshold (SCREEN-7): if screen changed within this many seconds of a user
# turn, inject a stale marker so Haiku can call refresh_vision for a fresh description.
SCREEN_STALE_THRESHOLD_S: float = 1.5

# Rate limit for background Gemini describe calls: prevents scroll bursts from spamming
# Gemini. At most one background describe every DESCRIBE_RATE_LIMIT_S seconds.
# Lowered from 2.0 to 1.0 since gemini-3.1-flash-lite-preview is fast enough.
DESCRIBE_RATE_LIMIT_S: float = 1.0

# Cache freshness window for describe_now(): if the cached description is younger than
# this, describe_now() returns it immediately without a redundant Gemini call.
DESCRIBE_NOW_CACHE_FRESH_S: float = 1.0

# Echo detection window (SCREEN-7) — how long to keep agent speech text for
# echo comparison. Must exceed max TTS audio duration (~10-15s).
ECHO_DETECTION_WINDOW_S: float = 15.0
