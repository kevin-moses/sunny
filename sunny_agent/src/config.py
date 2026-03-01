# config.py
# Purpose: Shared constants and configuration values for the Sunny voice agent.
# Contains voice UX parameters tuned for senior users, model identifiers, and
# other values referenced across agent, memory, prompt, and workflow modules.
# Added EMBEDDING_MODEL and WORKFLOW_MATCH_THRESHOLD for WF-4 Supabase workflow retrieval.
# Added VISION_LLM_MODEL for the SCREEN-4 vision-enabled handoff agent.
#
# Last modified: 2026-02-28

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

# Vision-enabled agent LLM (SCREEN-4) — must be a vision-capable model
VISION_LLM_MODEL = "gpt-4o"
