#!/usr/bin/env python3
# ingest_workflows.py
# Purpose: One-time (re-runnable) CLI to load all Sunny workflow definitions into Supabase.
# Reads manifest.yaml (896 entries) and workflows/*.json (88 files), generates OpenAI
# text-embedding-3-small embeddings in batches of 100, and upserts into the `workflows`
# and `workflow_steps` tables. Safe to re-run after editing JSON files — uses ON CONFLICT
# upsert semantics so the operation is fully idempotent.
#
# senior_description support (005_profile_summary migration):
#   Workflow JSON files may include a "senior_description" field — a plain-English
#   description written for older adults. This is now stored in workflows.senior_description
#   and is preferred over "description" for embedding generation because it contains
#   more natural language, improving semantic search quality.
#
# Usage:
#   cd sunny_agent
#   SUPABASE_URL=... SUPABASE_SECRET_KEY=... OPENAI_API_KEY=... uv run scripts/ingest_workflows.py
#
# Required env vars:
#   SUPABASE_URL          -- Supabase project URL
#   SUPABASE_SECRET_KEY   -- Supabase service role key (NOT the anon key)
#   OPENAI_API_KEY        -- OpenAI API key for embedding generation
#
# Last modified: 2026-02-26

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
from pathlib import Path
from typing import Any

import yaml
from dotenv import load_dotenv
from openai import AsyncOpenAI
from supabase import AsyncClient, create_async_client

load_dotenv(".env")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
logger = logging.getLogger("ingest_workflows")

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).parents[2]
WORKFLOWS_DIR = REPO_ROOT / "workflows"
MANIFEST_PATH = REPO_ROOT / "manifest.yaml"

EMBEDDING_MODEL = "text-embedding-3-small"
EMBEDDING_BATCH_SIZE = 100  # OpenAI allows up to 2048; 100 keeps requests small


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _load_manifest(manifest_path: Path) -> list[dict]:
    """
    purpose: Load and return the list of workflow entries from manifest.yaml.
    @param manifest_path: (Path) Path to manifest.yaml.
    @return: (list[dict]) List of manifest entry dicts with suggested_id, suggested_title, etc.
    """
    if not manifest_path.exists():
        logger.warning(f"Manifest not found at {manifest_path}")
        return []
    data = yaml.safe_load(manifest_path.read_text(encoding="utf-8")) or {}
    entries = data.get("workflows", [])
    if not isinstance(entries, list):
        return []
    # Filter out explicitly skipped entries
    return [e for e in entries if not e.get("skip", False)]


def _load_json_workflows(workflows_dir: Path) -> dict[str, dict]:
    """
    purpose: Load all workflow JSON files from disk, keyed by workflow id.
             Skips schema.json and any file that does not have a top-level 'id' field.
    @param workflows_dir: (Path) Directory containing workflow JSON files.
    @return: (dict[str, dict]) Map of workflow_id -> parsed workflow dict.
    """
    loaded: dict[str, dict] = {}
    if not workflows_dir.exists():
        logger.warning(f"Workflows directory not found at {workflows_dir}")
        return loaded
    for path in sorted(workflows_dir.glob("*.json")):
        if path.name == "schema.json":
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            workflow_id = data.get("id")
            if workflow_id:
                loaded[workflow_id] = data
        except Exception as exc:
            logger.warning(f"Skipping {path.name}: {exc}")
    return loaded


def _build_embedding_text(
    workflow_id: str,
    title: str,
    description: str,
    senior_description: str,
) -> str:
    """
    purpose: Build the text string used to generate the workflow embedding.
             Prefers senior_description over description when available, because
             senior_description is plain English written for older adults and
             produces higher-quality semantic search matches against natural
             language user queries.
    @param workflow_id: (str) Workflow identifier (unused here, available for future use).
    @param title: (str) Workflow title.
    @param description: (str) Technical workflow description, may be empty.
    @param senior_description: (str) Plain-English description for older adults, may be empty.
    @return: (str) Text to embed: "{title}: {senior_description}" if senior_description is
             set, else "{title}: {description}" if description is set, else just "{title}".
    """
    if senior_description:
        return f"{title}: {senior_description}"
    if description:
        return f"{title}: {description}"
    return title


def _normalize_common_issues(raw_issues: list[dict]) -> list[dict]:
    """
    purpose: Normalize common_issues from the JSON schema into the DB format.
             JSON files use either a 'problem' key or a 'trigger' list; both are
             collapsed into a single 'issue' label. The 'response' key passes through.
    @param raw_issues: (list[dict]) Raw issue dicts from workflow JSON.
    @return: (list[dict]) Normalized list with keys: issue, response.
    """
    normalized = []
    for item in raw_issues:
        if "problem" in item:
            label = item.get("problem", "").strip()
        elif "trigger" in item:
            triggers = item.get("trigger", [])
            label = (
                "; ".join(triggers[:2])
                if isinstance(triggers, list) and triggers
                else "Issue"
            )
        else:
            label = "Issue"
        normalized.append(
            {
                "issue": label,
                "response": item.get("response", ""),
            }
        )
    return normalized


async def _generate_embeddings(
    openai_client: AsyncOpenAI,
    texts: list[str],
) -> list[list[float]]:
    """
    purpose: Generate embeddings for a list of texts using OpenAI in batches.
             Uses text-embedding-3-small, 1536 dimensions.
    @param openai_client: (AsyncOpenAI) Initialized OpenAI async client.
    @param texts: (list[str]) Texts to embed.
    @return: (list[list[float]]) Embedding vectors, one per input text.
    """
    all_embeddings: list[list[float]] = []
    for i in range(0, len(texts), EMBEDDING_BATCH_SIZE):
        batch = texts[i : i + EMBEDDING_BATCH_SIZE]
        logger.info(
            f"Generating embeddings for batch {i // EMBEDDING_BATCH_SIZE + 1} ({len(batch)} items)..."
        )
        response = await openai_client.embeddings.create(
            model=EMBEDDING_MODEL,
            input=batch,
        )
        batch_embeddings = [item.embedding for item in response.data]
        all_embeddings.extend(batch_embeddings)
    return all_embeddings


async def _upsert_workflows(
    supabase: AsyncClient,
    manifest_entries: list[dict],
    json_workflows: dict[str, dict],
    embeddings: list[list[float]],
) -> None:
    """
    purpose: Upsert workflow rows into the `workflows` table, including the
             senior_description field added in migration 005.
             Iterates manifest entries (in the same order as embeddings were generated),
             then handles any JSON-only workflows that have no manifest entry.
    @param supabase: (AsyncClient) Authenticated Supabase client with service role.
    @param manifest_entries: (list[dict]) Manifest entries in the order used for embedding generation.
    @param json_workflows: (dict[str, dict]) All loaded workflow JSON dicts.
    @param embeddings: (list[list[float]]) Embeddings in the same order as manifest_entries.
    """
    rows: list[dict[str, Any]] = []

    for i, entry in enumerate(manifest_entries):
        workflow_id = entry.get("suggested_id", "")
        title = entry.get("suggested_title", workflow_id)
        json_wf = json_workflows.get(workflow_id, {})
        description = json_wf.get("description", "")
        senior_description = json_wf.get("senior_description", "")
        version = json_wf.get("version", "1.0.0")
        estimated_minutes = json_wf.get("estimated_minutes")
        source_type = json_wf.get("source_type")
        source_urls = json_wf.get("source_urls", [])

        # has_steps: True if the JSON has ios_versions keys or fallback_steps
        has_steps = bool(json_wf.get("ios_versions") or json_wf.get("fallback_steps"))

        rows.append(
            {
                "id": workflow_id,
                "title": title,
                "description": description,
                "senior_description": senior_description,
                "version": version,
                "estimated_minutes": estimated_minutes,
                "source_type": source_type,
                "source_urls": source_urls,
                "has_steps": has_steps,
                "embedding": embeddings[i],
            }
        )

    # Batch upsert in chunks to avoid payload size limits
    chunk_size = 50
    for i in range(0, len(rows), chunk_size):
        chunk = rows[i : i + chunk_size]
        await supabase.table("workflows").upsert(chunk, on_conflict="id").execute()
        logger.info(f"Upserted workflows rows {i + 1}-{i + len(chunk)}")


async def _upsert_workflow_steps(
    supabase: AsyncClient,
    json_workflows: dict[str, dict],
    manifest_ids: set[str],
) -> None:
    """
    purpose: Upsert all workflow step rows into the `workflow_steps` table.
             For each JSON workflow, inserts steps for each ios_version key and
             for fallback_steps (stored as ios_version='fallback').
             Only processes workflows whose IDs are present in manifest_ids to
             avoid foreign key violations from JSON files that have no corresponding
             workflows table row.
    @param supabase: (AsyncClient) Authenticated Supabase client with service role.
    @param json_workflows: (dict[str, dict]) All loaded workflow JSON dicts.
    @param manifest_ids: (set[str]) Set of workflow IDs already upserted into workflows table.
    """
    rows: list[dict[str, Any]] = []

    for workflow_id, wf in json_workflows.items():
        if workflow_id not in manifest_ids:
            logger.warning(
                f"Skipping steps for '{workflow_id}': no matching manifest entry "
                "(would cause a foreign key violation). Add it to manifest.yaml to include it."
            )
            continue
        ios_versions: dict = wf.get("ios_versions") or {}

        # Versioned steps
        for ios_version, steps in ios_versions.items():
            if not isinstance(steps, list):
                continue
            for idx, raw_step in enumerate(steps):
                rows.append(
                    _build_step_row(workflow_id, str(ios_version), idx, raw_step)
                )

        # Fallback steps stored as ios_version='fallback'
        fallback_steps = wf.get("fallback_steps") or []
        for idx, raw_step in enumerate(fallback_steps):
            rows.append(_build_step_row(workflow_id, "fallback", idx, raw_step))

    chunk_size = 100
    for i in range(0, len(rows), chunk_size):
        chunk = rows[i : i + chunk_size]
        await (
            supabase.table("workflow_steps")
            .upsert(chunk, on_conflict="workflow_id,ios_version,step_id")
            .execute()
        )
        logger.info(f"Upserted workflow_steps rows {i + 1}-{i + len(chunk)}")


def _build_step_row(
    workflow_id: str,
    ios_version: str,
    step_index: int,
    raw: dict,
) -> dict[str, Any]:
    """
    purpose: Build a workflow_steps DB row dict from a raw step dict.
    @param workflow_id: (str) Parent workflow identifier.
    @param ios_version: (str) iOS version key, e.g. '18' or 'fallback'.
    @param step_index: (int) Zero-based position of this step within its version list.
    @param raw: (dict) Raw step dict from the workflow JSON file.
    @return: (dict) Row dict ready for Supabase upsert.
    """
    return {
        "workflow_id": workflow_id,
        "ios_version": ios_version,
        "step_index": step_index,
        "step_id": raw.get("step_id", f"step_{step_index}"),
        "instruction": raw.get("instruction", ""),
        "visual_cue": raw.get("visual_cue", ""),
        "confirmation_prompt": raw.get("confirmation_prompt", ""),
        "success_indicators": raw.get("success_indicators") or [],
        "common_issues": _normalize_common_issues(raw.get("common_issues") or []),
        "fallback": raw.get("fallback", ""),
        "next_step": raw.get("next_step"),
    }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


async def main() -> None:
    """
    purpose: Entry point for the ingestion script.
             Loads manifest + JSON workflows, generates embeddings, and upserts
             all data into Supabase. Exits with a non-zero code on failure.
    """
    supabase_url = os.environ.get("SUPABASE_URL")
    supabase_key = os.environ.get("SUPABASE_SECRET_KEY")
    openai_api_key = os.environ.get("OPENAI_API_KEY")

    missing = [
        name
        for name, val in [
            ("SUPABASE_URL", supabase_url),
            ("SUPABASE_SECRET_KEY", supabase_key),
            ("OPENAI_API_KEY", openai_api_key),
        ]
        if not val
    ]
    if missing:
        logger.error(f"Missing required environment variables: {', '.join(missing)}")
        sys.exit(1)

    # Load source data
    manifest_entries = _load_manifest(MANIFEST_PATH)
    json_workflows = _load_json_workflows(WORKFLOWS_DIR)

    logger.info(f"Loaded {len(manifest_entries)} manifest entries")
    logger.info(f"Loaded {len(json_workflows)} workflow JSON files")

    # Build embedding texts (same order as manifest_entries — used later for upsert)
    embedding_texts = [
        _build_embedding_text(
            entry.get("suggested_id", ""),
            entry.get("suggested_title", ""),
            json_workflows.get(entry.get("suggested_id", ""), {}).get(
                "description", ""
            ),
            json_workflows.get(entry.get("suggested_id", ""), {}).get(
                "senior_description", ""
            ),
        )
        for entry in manifest_entries
    ]

    # Generate embeddings via OpenAI
    openai_client = AsyncOpenAI(api_key=openai_api_key)
    logger.info(f"Generating embeddings for {len(embedding_texts)} workflows...")
    embeddings = await _generate_embeddings(openai_client, embedding_texts)
    logger.info(f"Generated {len(embeddings)} embeddings")

    # Connect to Supabase and upsert
    supabase: AsyncClient = await create_async_client(supabase_url, supabase_key)

    logger.info("Upserting workflows...")
    await _upsert_workflows(supabase, manifest_entries, json_workflows, embeddings)

    manifest_ids = {e.get("suggested_id", "") for e in manifest_entries}
    logger.info("Upserting workflow_steps...")
    await _upsert_workflow_steps(supabase, json_workflows, manifest_ids)

    total_steps = sum(
        len(wf.get("ios_versions", {}).get(v, []))
        for wf in json_workflows.values()
        for v in (wf.get("ios_versions") or {})
    ) + sum(len(wf.get("fallback_steps") or []) for wf in json_workflows.values())
    logger.info(
        f"Ingestion complete: {len(manifest_entries)} workflows, ~{total_steps} steps upserted"
    )


if __name__ == "__main__":
    asyncio.run(main())
