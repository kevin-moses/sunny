// convex.config.ts
// Purpose: Registers the Convex components the backend uses: the rate limiter, which guards
// the unauthenticated /pair HTTP action (see pairing.ts), the workflow component that
// runs caregiver requests to the household agent (see agentRuntime.ts), and a workpool
// ("calendarSyncPool") that runs Google Calendar pushes with retry and bounded parallelism
// (see lib/calendarSync.ts), and "deliveryPool", which delivers notification outbox rows by
// APNs or SMS and composes the daily digest (see lib/delivery.ts).
//
// Last modified: 2026-10-29

import workpool from "@convex-dev/workpool/convex.config.js";
import workflow from "@convex-dev/workflow/convex.config.js";
import rateLimiter from "@convex-dev/rate-limiter/convex.config.js";
import { defineApp } from "convex/server";

const app = defineApp();
app.use(rateLimiter);
app.use(workflow);
app.use(workpool, { name: "calendarSyncPool" });
app.use(workpool, { name: "deliveryPool" });

export default app;
