// crons.ts
// Purpose: Recurring jobs. The scheduler tick runs every minute: it schedules one
// tickHousehold per household, each of which expands task instances, opens and closes
// confirmation windows and fires escalation steps (scheduler.ts). Replaces
// the pg_cron job `sunny-scheduler-tick`; a history cleanup is not needed because Convex
// does not keep per-run rows. Google Calendar housekeeping: every 10 minutes sweepStuckSyncs
// re-enqueues sync rows idle for 15 minutes (calendarFanOut.ts); every 10 minutes sweepStuck (delivery.ts) re-enqueues notification
// deliveries and daily digests left unsettled for 15 minutes; hourly sweepOauthStates
// deletes expired OAuth nonces (googleCalendar.ts).
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
crons.interval(
  "sweep expired oauth states",
  { hours: 1 },
  internal.googleCalendar.sweepOauthStates,
  {},
);

export default crons;
