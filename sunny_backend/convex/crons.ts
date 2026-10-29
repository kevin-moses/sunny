// crons.ts
// Purpose: Recurring jobs. The scheduler tick runs every minute: it schedules one
// tickHousehold per household, each of which expands task instances, opens and closes
// confirmation windows and fires escalation steps (scheduler.ts). Replaces
// the pg_cron job `sunny-scheduler-tick`; a history cleanup is not needed because Convex
// does not keep per-run rows.
//
// Last modified: 2026-10-28

import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("scheduler tick", { minutes: 1 }, internal.scheduler.tick, {});

export default crons;
