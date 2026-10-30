// crons.ts
// Purpose: Recurring jobs. The scheduler tick runs every minute: it schedules one
// tickHousehold per household, each of which expands task instances, opens and closes
// confirmation windows and fires escalation steps (scheduler.ts). Replaces the former Supabase pg_cron job
// `sunny-scheduler-tick`; a history cleanup is not needed because Convex does not keep per-run
// rows. Every 10 minutes: sweepStuckSyncs re-enqueues Google sync rows idle for 15 minutes
// (calendarFanOut.ts) and sweepStuck re-enqueues notification deliveries and daily digests
// left pending for 15 minutes (delivery.ts). Hourly: sweepOauthStates deletes expired OAuth
// nonces (googleCalendar.ts), phone.sweepExpired deletes expired phone verifications and
// sms.sweepInbound deletes handled-text records past their expiry.
//
// Last modified: 2026-10-29

import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("scheduler tick", { minutes: 1 }, internal.scheduler.tick, {});
crons.interval(
  "sweep stuck calendar syncs",
  { minutes: 10 },
  internal.calendarFanOut.sweepStuckSyncs,
  {},
);
crons.interval("sweep stuck deliveries", { minutes: 10 }, internal.delivery.sweepStuck, {});
crons.interval("sweep expired phone verifications", { hours: 1 }, internal.phone.sweepExpired, {});
crons.interval("sweep handled inbound texts", { hours: 1 }, internal.sms.sweepInbound, {});
crons.interval(
  "sweep expired oauth states",
  { hours: 1 },
  internal.googleCalendar.sweepOauthStates,
  {},
);

export default crons;
