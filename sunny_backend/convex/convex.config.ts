import workpool from "@convex-dev/workpool/convex.config.js";
import workflow from "@convex-dev/workflow/convex.config.js";
import rateLimiter from "@convex-dev/rate-limiter/convex.config.js";
import { defineApp } from "convex/server";

const app = defineApp();
app.use(rateLimiter);
app.use(workflow);
app.use(workpool, { name: "calendarSyncPool" });
app.use(workpool, { name: "deliveryPool" });
app.use(workpool, { name: "mailPool" });

export default app;
