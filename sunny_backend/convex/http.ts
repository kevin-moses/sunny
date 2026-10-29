// convex/http.ts
// Purpose: HTTP routes of the backend. POST /pair lets a signed-out senior device redeem a
// join code for a Clerk sign-in ticket (pairing.ts). GET /google/callback is where Google
// redirects a caregiver's browser after consent (googleCalendar.ts). Native clients only for
// /pair, so no CORS.
//
// Last modified: 2026-10-29

import { httpRouter } from "convex/server";
import { callback as googleCallback } from "./googleCalendar";
import { pair } from "./pairing";

const http = httpRouter();

http.route({ path: "/pair", method: "POST", handler: pair });
http.route({ path: "/google/callback", method: "GET", handler: googleCallback });

export default http;
