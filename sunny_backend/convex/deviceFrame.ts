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

export const DONE_INSTANCE_HEADER = "Sunny-Done-Instance";

const FRAME_CONTENT_TYPES: Record<FrameFormat, string> = {
  png: "image/png",
  packed: "application/octet-stream",
};

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
