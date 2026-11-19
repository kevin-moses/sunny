import { Workpool } from "@convex-dev/workpool";
import { components } from "../_generated/api";

const MAX_PARALLEL_MAIL_JOBS = 5;

const MAIL_RETRY = { maxAttempts: 3, initialBackoffMs: 5_000, base: 2 };

export const mailPool = new Workpool(components.mailPool, {
  maxParallelism: MAX_PARALLEL_MAIL_JOBS,
  retryActionsByDefault: true,
  defaultRetryBehavior: MAIL_RETRY,
});
