import { httpRouter } from "convex/server";
import {
  confirm as deviceConfirm,
  getState as deviceState,
  getTimeline as deviceTimeline,
  putInfo as deviceInfo,
} from "./deviceApi";
import { getFrame as deviceFrame } from "./deviceFrame";
import { callback as googleCallback, start as googleStart } from "./googleCalendar";
import { pair } from "./pairing";
import { inbound as twilioInbound } from "./sms";

const http = httpRouter();

http.route({ path: "/pair", method: "POST", handler: pair });
http.route({ path: "/google/start", method: "GET", handler: googleStart });
http.route({ path: "/google/callback", method: "GET", handler: googleCallback });
http.route({ path: "/twilio/sms", method: "POST", handler: twilioInbound });
http.route({ path: "/device/state", method: "GET", handler: deviceState });
http.route({ path: "/device/timeline", method: "GET", handler: deviceTimeline });
http.route({ path: "/device/frame", method: "GET", handler: deviceFrame });
http.route({ path: "/device/confirm", method: "POST", handler: deviceConfirm });
http.route({ path: "/device/info", method: "PUT", handler: deviceInfo });

export default http;
