// convex.config.ts
// Purpose: Registers the Convex components the backend uses: the rate limiter, which guards
// the unauthenticated /pair HTTP action (see pairing.ts), and the workflow component that
// runs caregiver requests to the household agent (see agentRuntime.ts).
//
// Last modified: 2026-10-29

import workflow from "@convex-dev/workflow/convex.config.js";
import rateLimiter from "@convex-dev/rate-limiter/convex.config.js";
import { defineApp } from "convex/server";

const app = defineApp();
app.use(rateLimiter);
app.use(workflow);

export default app;
