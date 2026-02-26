-- =============================================================================
-- 004_workflows.sql
--
-- Workflow storage for Sunny guided-step iPhone help system.
-- Replaces the file-based WorkflowEngine with Supabase-backed semantic search.
--
-- Tables:
--   workflows       -- one row per workflow; stores pgvector embedding for title+description
--   workflow_steps  -- one row per step per (workflow, ios_version)
--
-- RPCs:
--   match_workflow(query_embedding, match_threshold, match_count)
--       -- cosine similarity search over workflow embeddings
--   get_workflow_steps(p_workflow_id, p_ios_version)
--       -- returns ordered steps with fallback to 'fallback' version
--
-- Indexing: HNSW index on workflows.embedding for sub-millisecond ANN search.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 0. Enable pgvector
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------------------
-- 1. workflows
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workflows (
    id                text        PRIMARY KEY,
    title             text        NOT NULL,
    description       text        NOT NULL DEFAULT '',
    version           text        NOT NULL DEFAULT '1.0.0',
    estimated_minutes integer,
    source_type       text,
    source_urls       text[]      NOT NULL DEFAULT '{}',
    has_steps         boolean     NOT NULL DEFAULT false,
    embedding         vector(1536),
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);

-- HNSW index for fast cosine similarity search
CREATE INDEX IF NOT EXISTS idx_workflows_embedding_hnsw
    ON workflows
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

ALTER TABLE workflows ENABLE ROW LEVEL SECURITY;

CREATE POLICY workflows_permissive ON workflows
    FOR ALL USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- 2. workflow_steps
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workflow_steps (
    id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_id          text        NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    -- ios_version: '16' | '17' | '18' | '26' | 'fallback'
    ios_version          text        NOT NULL,
    step_index           integer     NOT NULL,
    step_id              text        NOT NULL,
    instruction          text        NOT NULL DEFAULT '',
    visual_cue           text        NOT NULL DEFAULT '',
    confirmation_prompt  text        NOT NULL DEFAULT '',
    success_indicators   text[]      NOT NULL DEFAULT '{}',
    -- common_issues stored as JSONB array: [{issue: str, response: str}]
    common_issues        jsonb       NOT NULL DEFAULT '[]',
    fallback             text        NOT NULL DEFAULT '',
    next_step            text,
    UNIQUE (workflow_id, ios_version, step_id)
);

CREATE INDEX IF NOT EXISTS idx_workflow_steps_workflow_version
    ON workflow_steps(workflow_id, ios_version, step_index);

ALTER TABLE workflow_steps ENABLE ROW LEVEL SECURITY;

CREATE POLICY workflow_steps_permissive ON workflow_steps
    FOR ALL USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- 3. RPC: match_workflow
--    Returns the best-matching workflows by cosine similarity.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION match_workflow(
    query_embedding  vector(1536),
    match_threshold  float          DEFAULT 0.5,
    match_count      int            DEFAULT 5
)
RETURNS TABLE (
    workflow_id  text,
    title        text,
    description  text,
    has_steps    boolean,
    similarity   float
)
LANGUAGE sql STABLE
AS $$
    SELECT
        w.id          AS workflow_id,
        w.title,
        w.description,
        w.has_steps,
        1 - (w.embedding <=> query_embedding) AS similarity
    FROM workflows w
    WHERE w.embedding IS NOT NULL
      AND 1 - (w.embedding <=> query_embedding) >= match_threshold
    ORDER BY w.embedding <=> query_embedding
    LIMIT match_count;
$$;

-- ---------------------------------------------------------------------------
-- 4. RPC: get_workflow_steps
--    Returns ordered steps for (workflow_id, ios_version).
--    Falls back to 'fallback' ios_version if no rows exist for the requested version.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_workflow_steps(
    p_workflow_id   text,
    p_ios_version   text
)
RETURNS TABLE (
    step_index           integer,
    step_id              text,
    instruction          text,
    visual_cue           text,
    confirmation_prompt  text,
    success_indicators   text[],
    common_issues        jsonb,
    fallback             text,
    next_step            text
)
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    v_version text := p_ios_version;
BEGIN
    -- Check if rows exist for the requested iOS version; fall back if not
    IF NOT EXISTS (
        SELECT 1
        FROM workflow_steps ws
        WHERE ws.workflow_id = p_workflow_id
          AND ws.ios_version = p_ios_version
    ) THEN
        v_version := 'fallback';
    END IF;

    RETURN QUERY
        SELECT
            ws.step_index,
            ws.step_id,
            ws.instruction,
            ws.visual_cue,
            ws.confirmation_prompt,
            ws.success_indicators,
            ws.common_issues,
            ws.fallback,
            ws.next_step
        FROM workflow_steps ws
        WHERE ws.workflow_id = p_workflow_id
          AND ws.ios_version = v_version
        ORDER BY ws.step_index;
END;
$$;
