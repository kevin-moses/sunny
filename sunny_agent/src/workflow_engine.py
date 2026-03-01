# workflow_engine.py
# Purpose: Workflow discovery, resolution, and step normalization for Sunny guided workflows.
# Replaced file-based token matching with Supabase pgvector semantic search (WF-4).
# find_workflow() generates an OpenAI embedding and calls the match_workflow RPC.
# resolve_workflow() calls the get_workflow_steps RPC and builds a WorkflowState.
# In-memory _step_cache avoids repeated DB round-trips for steps already fetched this session.
#
# Active workflow state (SCREEN-4): WorkflowEngine owns _active_state so that workflow
# progress survives agent handoffs (e.g. voice -> VisionAssistant -> voice). Both agents
# share the same engine reference, so get/set/clear_active_state operate on the same slot.
#
# Last modified: 2026-02-28

from __future__ import annotations

import logging
import os
from dataclasses import dataclass

from openai import AsyncOpenAI
from supabase import AsyncClient

from config import EMBEDDING_MODEL, WORKFLOW_MATCH_THRESHOLD

logger = logging.getLogger("workflow_engine")


@dataclass
class WorkflowStep:
    """
    purpose: Represent a normalized workflow step.
    @param step_id: (str) Unique identifier for the step.
    @param instruction: (str) Spoken instruction for the user.
    @param visual_cue: (str) Visual cue describing what to look for.
    @param confirmation_prompt: (str) Question to confirm the user completed the step.
    @param success_indicators: (list[str]) Phrases indicating success, if available.
    @param common_issues: (list[dict]) List of issue dicts with keys: issue, response.
    @param fallback: (str) Alternate instruction if the main step fails.
    @param next_step: (str | None) Next step_id or None if final.
    """

    step_id: str
    instruction: str
    visual_cue: str
    confirmation_prompt: str
    success_indicators: list[str]
    common_issues: list[dict]
    fallback: str
    next_step: str | None


@dataclass
class WorkflowState:
    """
    purpose: Track the active workflow state for a session.
    @param workflow_id: (str) Workflow identifier.
    @param workflow_title: (str) Workflow title.
    @param step_ids: (list[str]) Ordered step IDs for the resolved iOS version.
    @param step_map: (dict[str, WorkflowStep]) Step lookup by step_id.
    @param current_index: (int) Current step index.
    @param history: (list[int]) History of visited step indices for go-back support.
    """

    workflow_id: str
    workflow_title: str
    step_ids: list[str]
    step_map: dict[str, WorkflowStep]
    current_index: int
    history: list[int]


class WorkflowEngine:
    """
    purpose: Async Supabase-backed workflow engine.
             find_workflow() uses OpenAI embeddings + pgvector cosine similarity to find
             the best-matching workflow for a user task description.
             resolve_workflow() fetches ordered steps from the DB with automatic iOS
             version fallback, and caches results for the session lifetime.
             _active_state holds the currently running WorkflowState (if any) and is
             shared across agent handoffs via get/set/clear_active_state().
    """

    def __init__(self, supabase: AsyncClient) -> None:
        """
        purpose: Initialize the workflow engine with a Supabase async client.
        @param supabase: (AsyncClient) Authenticated Supabase async client.
        """
        self._supabase = supabase
        self._openai = AsyncOpenAI()
        # Warn early if OPENAI_API_KEY is absent — find_workflow() will fail at runtime
        if not os.environ.get("OPENAI_API_KEY"):
            logger.warning(
                "OPENAI_API_KEY is not set — find_workflow() will fail at runtime"
            )
        # Cache of (workflow_id, ios_version) -> WorkflowState template.
        # Only the immutable step data is cached; each call returns a fresh
        # WorkflowState with current_index=0 and history=[] so that re-starting
        # the same workflow always begins at step 1.
        self._step_cache: dict[tuple[str, str], WorkflowState] = {}
        # Active workflow state shared across agent handoffs (SCREEN-4).
        self._active_state: WorkflowState | None = None

    def get_active_state(self) -> WorkflowState | None:
        """
        purpose: Return the currently active WorkflowState, or None if no workflow is running.
        @return: (WorkflowState | None) The active workflow state.
        """
        return self._active_state

    def set_active_state(self, state: WorkflowState) -> None:
        """
        purpose: Set the active WorkflowState. Called by start_workflow when a workflow begins.
        @param state: (WorkflowState) The workflow state to make active.
        """
        self._active_state = state

    def clear_active_state(self) -> None:
        """
        purpose: Clear the active WorkflowState. Called by exit_workflow or confirm_step
                 when the workflow completes or is abandoned.
        """
        self._active_state = None

    async def find_workflow(self, task_description: str) -> tuple[str, str, bool]:
        """
        purpose: Find the best-matching workflow for a task description using semantic search.
                 Generates an OpenAI embedding for the description and calls the
                 match_workflow Supabase RPC.
        @param task_description: (str) User-provided task description.
        @return: (tuple[str, str, bool]) (workflow_id, workflow_title, has_steps).
                 Returns ("", "", False) when no match exceeds the similarity threshold.
        """
        if not task_description.strip():
            return "", "", False

        try:
            embedding_response = await self._openai.embeddings.create(
                model=EMBEDDING_MODEL,
                input=task_description,
            )
            embedding = embedding_response.data[0].embedding
        except Exception as exc:
            logger.error(f"Embedding generation failed for '{task_description}': {exc}")
            return "", "", False

        try:
            result = await self._supabase.rpc(
                "match_workflow",
                {
                    "query_embedding": embedding,
                    "match_threshold": WORKFLOW_MATCH_THRESHOLD,
                    "match_count": 1,
                },
            ).execute()
        except Exception as exc:
            logger.error(f"match_workflow RPC failed: {exc}")
            return "", "", False

        rows = result.data or []
        if not rows:
            return "", "", False

        best = rows[0]
        return best["workflow_id"], best["title"], best["has_steps"]

    async def resolve_workflow(
        self,
        workflow_id: str,
        ios_version: str,
        workflow_title: str = "",
    ) -> WorkflowState:
        """
        purpose: Resolve a workflow into a WorkflowState for the given iOS version.
                 Calls the get_workflow_steps RPC (which auto-falls back to 'fallback'
                 version if the requested iOS version has no steps). Results are cached
                 in _step_cache to avoid repeated DB fetches within the same session.
                 Each call returns a fresh WorkflowState with current_index=0 and
                 history=[] so that re-starting a workflow always begins at step 1.
        @param workflow_id: (str) Workflow identifier.
        @param ios_version: (str) iOS major version string, e.g. "18" or "unknown".
        @param workflow_title: (str) Optional title; if provided avoids a DB round-trip.
        @return: (WorkflowState) Resolved workflow state, ready for step-by-step guidance.
        """
        cache_key = (workflow_id, ios_version)
        if cache_key in self._step_cache:
            cached = self._step_cache[cache_key]
            # Return a fresh state shell so current_index / history are always reset.
            # step_ids is copied; step_map is shared because WorkflowStep is never mutated.
            return WorkflowState(
                workflow_id=cached.workflow_id,
                workflow_title=cached.workflow_title,
                step_ids=list(cached.step_ids),
                step_map=cached.step_map,
                current_index=0,
                history=[],
            )

        result = await self._supabase.rpc(
            "get_workflow_steps",
            {
                "p_workflow_id": workflow_id,
                "p_ios_version": ios_version,
            },
        ).execute()

        rows = result.data or []

        # Use the caller-supplied title when available to avoid an extra DB round-trip
        if not workflow_title:
            title_result = (
                await self._supabase.table("workflows")
                .select("title")
                .eq("id", workflow_id)
                .single()
                .execute()
            )
            workflow_title = (title_result.data or {}).get("title", workflow_id)

        step_map: dict[str, WorkflowStep] = {}
        step_ids: list[str] = []

        for row in rows:
            raw_issues = row.get("common_issues") or []
            # common_issues are already normalized in DB (inserted by ingest_workflows.py)
            common_issues = raw_issues if isinstance(raw_issues, list) else []

            step = WorkflowStep(
                step_id=row["step_id"],
                instruction=row.get("instruction", ""),
                visual_cue=row.get("visual_cue", ""),
                confirmation_prompt=row.get("confirmation_prompt", ""),
                success_indicators=row.get("success_indicators") or [],
                common_issues=common_issues,
                fallback=row.get("fallback", ""),
                next_step=row.get("next_step"),
            )
            step_map[step.step_id] = step
            step_ids.append(step.step_id)

        state = WorkflowState(
            workflow_id=workflow_id,
            workflow_title=workflow_title,
            step_ids=step_ids,
            step_map=step_map,
            current_index=0,
            history=[],
        )
        self._step_cache[cache_key] = state
        return state
