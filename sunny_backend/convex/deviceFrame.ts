// convex/deviceFrame.ts
// Purpose: GET /device/frame, the e-ink home display's server-drawn frames, in a module of its
// own so the renderer and its 529 KB of font data (lib/frame.ts) load only for this route,
// never for the other device functions (deviceApi.ts).
//
//   GET /device/frame?page=now|today&format=png|packed
//     Bearer device token, through deviceApi.ts's gate (token, the device's rate limit,
//     lastSeenAt) and deviceRoute (every answer no-store JSON on failure). The token's own
//     device state (frameSourceByToken: the device found by its token hash, its household's
//     state, its own reported screen) drawn for that screen, 960 x 680 with 4 greys
//     (DEFAULT_SCREEN) until it reports one, as image/png or the packed firmware format
//     (application/octet-stream, lib/framePacked.ts). 200 with ETag; 304 with no body when
//     If-None-Match matches, decided before anything is drawn. 400 for a missing, unknown or
//     repeated page or format, any other parameter, or a reported screen outside what frames
//     are drawn for (lib/frame.ts DRAWABLE_SCREEN); 401 bad token; 429 rate limited. Drawing
//     takes milliseconds, so nothing is cached.
//   Every 200 and 304 carries Sunny-Done-Instance: the task instance a Done press confirms
//     while this frame is on screen (lib/frame.ts frameDoneInstance: the due Now task, never
//     one inside its early hour). The header is absent when Done confirms nothing. Firmware
//     contract: on a Done press, POST /device/confirm with exactly the id of the frame on
//     screen (via "button"), and send nothing when its frame had none. The confirm route also
//     refuses a button press on a task not due yet.
//
// Last modified: 2026-11-14

import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalQuery } from "./_generated/server";
import {
  deviceRoute,
  findDeviceByTokenHash,
  gate,
  notModified,
  unauthorizedResponse,
} from "./deviceApi";
import { loadDeviceState } from "./lib/deviceState";
import type { CarouselPage, DeviceState } from "./lib/deviceState";
import {
  DEFAULT_SCREEN,
  DRAWABLE_SCREEN,
  FRAME_PAGES,
  buildFrameModel,
  drawFrame,
  frameDoneInstance,
  frameEtag,
  isDrawableScreen,
} from "./lib/frame";
import type { FrameFormat } from "./lib/frame";
import { encodePacked } from "./lib/framePacked";
import { encodePng } from "./lib/framePng";
import { NO_STORE, errorResponse } from "./lib/httpResponse";
import type { DeviceScreen } from "./lib/validators";

/** The response header naming the task instance Done confirms for a frame. */
export const DONE_INSTANCE_HEADER = "Sunny-Done-Instance";

/** The Content-Type of each frame format. */
const FRAME_CONTENT_TYPES: Record<FrameFormat, string> = {
  png: "image/png",
  packed: "application/octet-stream",
};

/**
 * purpose: What a frame is drawn from: the token's device state and the screen its device
 *          reported (null when it has not). Internal.
 * @param tokenHash: (string) SHA-256 hex of the token.
 * @return: ({ state, screen } | null) The source, or null when the token no longer resolves.
 */
export const frameSourceByToken = internalQuery({
  args: { tokenHash: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{ state: DeviceState; screen: DeviceScreen | null } | null> => {
    const device = await findDeviceByTokenHash(ctx, args.tokenHash);
    if (device === null) return null;
    const state = await loadDeviceState(ctx, device.householdId, Date.now());
    return { state, screen: device.screen ?? null };
  },
});

/**
 * purpose: Read GET /device/frame's query: exactly one page (now or today) and one format (png
 *          or packed), nothing else.
 * @param url: (URL) The request URL.
 * @return: ({ page, format } | string) The choice, or the 400 message.
 */
function parseFrameQuery(url: URL): { page: CarouselPage; format: FrameFormat } | string {
  const params = url.searchParams;
  const extra = [...params.keys()].find((k) => k !== "page" && k !== "format");
  if (extra !== undefined) return "Only the page and format parameters are allowed";
  const pages = params.getAll("page");
  const formats = params.getAll("format");
  const page = pages[0] as CarouselPage;
  const format = formats[0] as FrameFormat;
  if (pages.length !== 1 || !FRAME_PAGES.includes(page)) {
    return `page must be one of ${FRAME_PAGES.join(", ")}`;
  }
  if (formats.length !== 1 || !Object.hasOwn(FRAME_CONTENT_TYPES, format)) {
    return "format must be one of png, packed";
  }
  return { page, format };
}

/**
 * purpose: GET /device/frame (the module header describes it): the token's own state drawn for
 *          its device's screen, with the ETag and the Done instance; 304 before drawing.
 * @param ctx: (ActionCtx) Action context.
 * @param request: (Request) The HTTP request.
 * @return: (Response) The response.
 */
export const getFrame = deviceRoute("Could not draw the frame", async (ctx, request) => {
  const tokenHash = await gate(ctx, request);
  if (tokenHash instanceof Response) return tokenHash;
  const query = parseFrameQuery(new URL(request.url));
  if (typeof query === "string") return errorResponse(400, "invalid", query);
  const source = await ctx.runQuery(internal.deviceFrame.frameSourceByToken, { tokenHash });
  if (source === null) return unauthorizedResponse();
  const screen = source.screen ?? DEFAULT_SCREEN;
  if (!isDrawableScreen(screen)) {
    return errorResponse(
      400,
      "invalid",
      `Frames are drawn for screens of ${DRAWABLE_SCREEN.minWidth} x ${DRAWABLE_SCREEN.minHeight} to ${DRAWABLE_SCREEN.maxWidth} x ${DRAWABLE_SCREEN.maxHeight} pixels`,
    );
  }
  const done = frameDoneInstance(source.state);
  const doneHeader: Record<string, string> = done === null ? {} : { [DONE_INSTANCE_HEADER]: done };
  const model = buildFrameModel(source.state, query.page);
  const etag = `"${frameEtag(model, screen, query.format)}"`;
  const cached = notModified(request, etag, doneHeader);
  if (cached !== null) return cached;
  const frame = drawFrame(model, screen);
  const body = query.format === "png" ? encodePng(frame) : encodePacked(frame);
  return new Response(body, {
    status: 200,
    headers: {
      ...NO_STORE,
      ...doneHeader,
      "Content-Type": FRAME_CONTENT_TYPES[query.format],
      ETag: etag,
    },
  });
});
