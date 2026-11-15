// convex/http.ts
// Purpose: HTTP routes of the backend. POST /pair lets a signed-out senior device redeem a
// join code for a Clerk sign-in ticket (pairing.ts). GET /google/callback is where Google
// redirects a caregiver's browser after consent (googleCalendar.ts). POST /twilio/sms is
// Twilio's inbound SMS webhook (sms.ts; the signature is checked there). The device API
// (deviceApi.ts; Bearer device token): GET /device/state, POST /device/confirm and PUT
// /device/info, and GET /device/frame (deviceFrame.ts, the e-ink display's server-drawn
// frames), for the widget, Live Activity and e-ink display firmware. Native clients only for
// /pair and /device/*, so no CORS.
//
// Last modified: 2026-11-14

import { httpRouter } from "convex/server";
import {
  confirm as deviceConfirm,
  getState as deviceState,
  putInfo as deviceInfo,
} from "./deviceApi";
import { getFrame as deviceFrame } from "./deviceFrame";
import { callback as googleCallback } from "./googleCalendar";
import { pair } from "./pairing";
import { inbound as twilioInbound } from "./sms";

const http = httpRouter();

http.route({ path: "/pair", method: "POST", handler: pair });
http.route({ path: "/google/callback", method: "GET", handler: googleCallback });
http.route({ path: "/twilio/sms", method: "POST", handler: twilioInbound });
http.route({ path: "/device/state", method: "GET", handler: deviceState });
http.route({ path: "/device/frame", method: "GET", handler: deviceFrame });
http.route({ path: "/device/confirm", method: "POST", handler: deviceConfirm });
http.route({ path: "/device/info", method: "PUT", handler: deviceInfo });

export default http;
