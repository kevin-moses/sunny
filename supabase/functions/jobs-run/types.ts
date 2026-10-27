// jobs-run/types.ts
// Purpose: Shared types for the job runner: the job row as claim_job returns it, the
// outcome every handler returns (done or defer), and the error that tells the runner not
// to retry.
//
// Last modified: 2026-10-27

/** A row of public.jobs as returned by claim_job. */
export interface Job {
  id: string;
  household_id: string;
  kind: "agent_chat" | "calendar_sync_event";
  payload: Record<string, unknown>;
  status: string;
  attempts: number;
  max_attempts: number;
  requested_by: string | null;
  checkpoint: Record<string, unknown>;
  created_at: string;
}

/** What a handler decided: finished with a result, or paused until a later time. */
export type JobOutcome =
  | { type: "done"; result: Record<string, unknown> }
  | { type: "defer"; checkpoint: Record<string, unknown>; resumeAt: Date; waiting: boolean };

/** A failure that retrying cannot fix (bad input, missing configuration). */
export class PermanentJobError extends Error {}
