// jobs-run/index.ts
// Purpose: Runs one background job. Called by the database (pg_net, on insert and from
// the minute sweep) with { job_id } and the shared secret header x-sunny-jobs-secret
// (Vault 'sunny_jobs_secret' = env SUNNY_JOBS_SECRET). Answers 202 at once and does the
// work in the background (EdgeRuntime.waitUntil): claim the job, run its handler, then
// complete, defer or fail it. Claims are atomic, so duplicate calls are harmless.
// Handlers: calendar_sync_event (calendar.ts) and agent_chat (agent.ts, through the
// AgentRuntime interface). See notes/AGENT_RUNTIME.md.
//
// Last modified: 2026-10-27

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { safeEqual, serviceClient } from "../_shared/admin.ts";
import { error, UUID_REGEX } from "../_shared/response.ts";
import { ManagedAgentsRuntime } from "./agent.ts";
import { syncCalendarEvent } from "./calendar.ts";
import { type Job, type JobOutcome, PermanentJobError } from "./types.ts";

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

const LEASE_SECONDS = 300;
// Time a run may take before it defers; stays under the Edge Function wall-clock limit.
const RUN_BUDGET_MS = (() => {
  const ms = Number(Deno.env.get("SUNNY_JOB_RUN_BUDGET_MS") || "120000");
  return Number.isFinite(ms) && ms >= 10_000 ? ms : 120_000;
})();

/**
 * purpose: Run the handler for a job's kind.
 * @param db: (SupabaseClient) Service-role client.
 * @param job: (Job) Claimed job.
 * @param deadline: (number) Epoch ms by which the handler must return.
 * @return: (Promise<JobOutcome>) The handler's outcome.
 */
function handle(db: SupabaseClient, job: Job, deadline: number): Promise<JobOutcome> {
  switch (job.kind) {
    case "calendar_sync_event":
      return syncCalendarEvent(db, job);
    case "agent_chat":
      return new ManagedAgentsRuntime(db).run(job, deadline);
    default:
      throw new PermanentJobError(`Unknown job kind ${job.kind}`);
  }
}

/**
 * purpose: Claim and run one job, recording the outcome. Never throws.
 * @param jobId: (string) Job id from the request.
 */
async function runJob(jobId: string): Promise<void> {
  const db = serviceClient();
  const { data: claimed, error: claimError } = await db.rpc("claim_job", {
    p_job_id: jobId,
    p_lease_seconds: LEASE_SECONDS,
  });
  if (claimError) {
    console.error(`jobs-run: claim ${jobId} failed: ${claimError.message}`);
    return;
  }
  const job = (claimed as Job[] | null)?.[0];
  if (!job) return; // taken by another call, not due, or the household is paused

  try {
    const outcome = await handle(db, job, Date.now() + RUN_BUDGET_MS);
    const { error: finishError } = outcome.type === "done"
      ? await db.rpc("complete_job", { p_job_id: job.id, p_result: outcome.result })
      : await db.rpc("defer_job", {
        p_job_id: job.id,
        p_checkpoint: outcome.checkpoint,
        p_resume_at: outcome.resumeAt.toISOString(),
        p_waiting: outcome.waiting,
      });
    if (finishError) console.error(`jobs-run: finishing ${job.id} failed: ${finishError.message}`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`jobs-run: ${job.kind} ${job.id} failed: ${message}`);
    const { error: failError } = await db.rpc("fail_job", {
      p_job_id: job.id,
      p_error: message,
      p_retry: !(e instanceof PermanentJobError),
    });
    if (failError) console.error(`jobs-run: recording failure of ${job.id} failed: ${failError.message}`);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return error("Method not allowed", "METHOD_NOT_ALLOWED", 405);
  }
  const secret = Deno.env.get("SUNNY_JOBS_SECRET");
  if (!secret || !safeEqual(req.headers.get("x-sunny-jobs-secret") ?? "", secret)) {
    return error("Forbidden", "FORBIDDEN", 403);
  }
  let jobId: unknown;
  try {
    jobId = (await req.json()).job_id;
  } catch {
    return error("Request body must be valid JSON", "INVALID_BODY", 400);
  }
  if (typeof jobId !== "string" || !UUID_REGEX.test(jobId)) {
    return error("job_id must be a UUID", "INVALID_JOB_ID", 400);
  }
  EdgeRuntime.waitUntil(runJob(jobId));
  return new Response(null, { status: 202 });
});
