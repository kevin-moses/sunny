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
crons.interval("sweep expired oauth flows", { hours: 1 }, internal.googleOauth.sweepOauthFlows, {});

crons.interval("poll gmail mailboxes", { minutes: 5 }, internal.gmail.pollAll, {});
crons.interval("sweep stuck mail", { minutes: 10 }, internal.mailTriage.sweepStuck, {});

export default crons;
