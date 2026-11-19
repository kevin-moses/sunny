import { Workpool } from "@convex-dev/workpool";
import { components, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { MINUTE_MS } from "./time";

const MAX_PARALLEL_MAIL_JOBS = 5;

const MAIL_RETRY = { maxAttempts: 3, initialBackoffMs: 5_000, base: 2 };

const TRIAGE_RETRY = { maxAttempts: 5, initialBackoffMs: 30_000, base: 2 };

export const TRIAGE_PICKUP_MS = 15 * MINUTE_MS;

export const mailPool = new Workpool(components.mailPool, {
  maxParallelism: MAX_PARALLEL_MAIL_JOBS,
  retryActionsByDefault: true,
  defaultRetryBehavior: MAIL_RETRY,
});

export async function enqueueTriage(ctx: MutationCtx, itemId: Id<"mailItems">): Promise<void> {
  await mailPool.enqueueAction(
    ctx,
    internal.mailTriage.triage,
    { itemId },
    {
      onComplete: internal.mailTriage.onMailJobComplete,
      context: { itemId },
      retry: TRIAGE_RETRY,
    },
  );
}
