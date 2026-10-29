// convex/http.ts
// Purpose: HTTP routes of the backend. POST /pair lets a signed-out senior device redeem a
// join code for a Clerk sign-in ticket (pairing.ts). Native clients only, so no CORS.
//
// Last modified: 2026-10-29

import { httpRouter } from "convex/server";
import { pair } from "./pairing";

const http = httpRouter();

http.route({ path: "/pair", method: "POST", handler: pair });

export default http;
