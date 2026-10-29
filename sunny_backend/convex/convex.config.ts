// convex.config.ts
// Purpose: Registers the Convex components the backend uses. Currently only the rate
// limiter, which guards the unauthenticated /pair HTTP action (see pairing.ts).
//
// Last modified: 2026-10-29

import rateLimiter from "@convex-dev/rate-limiter/convex.config.js";
import { defineApp } from "convex/server";

const app = defineApp();
app.use(rateLimiter);

export default app;
