import type { ObjectType } from "convex/values";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { loadHousehold } from "./access";
import type { Actor } from "./access";
import { audit } from "./audit";
import { resyncHouseholdCalendars } from "./calendarSync";
import { appError } from "./errors";
import { resyncHouseholdTimezone } from "./schedule";
import { cleanOptional, requireNonBlank } from "./text";
import { canonicalTimezone, isLocalTime } from "./time";

const MAX_WEATHER_LOCATION_LENGTH = 100;

export function requireTimezone(timezone: string): string {
  const canonical = canonicalTimezone(timezone);
  if (canonical === null) throw appError("invalid", `Unknown timezone ${timezone}`);
  return canonical;
}

function assertTime(time: string, label: string): void {
  if (!isLocalTime(time)) throw appError("invalid", `${label} must be HH:MM`);
}

export const householdSettingsFields = {
  seniorPreferredName: v.optional(v.string()),
  seniorFullName: v.optional(v.string()),
  timezone: v.optional(v.string()),
  digestTime: v.optional(v.string()),
  eventNoticeTime: v.optional(v.string()),
  shareTranscripts: v.optional(v.boolean()),
  backgroundPaused: v.optional(v.boolean()),
  weatherLocation: v.optional(v.string()),
};

export type HouseholdSettingsChanges = ObjectType<typeof householdSettingsFields>;

export async function updateHouseholdCore(
  ctx: MutationCtx,
  actor: Actor,
  householdId: Id<"households">,
  fields: HouseholdSettingsChanges,
): Promise<Doc<"households">> {
  const household = await loadHousehold(ctx, householdId);
  const patch: Partial<Omit<Doc<"households">, "_id" | "_creationTime">> = {};
  if (fields.seniorPreferredName !== undefined) {
    patch.seniorPreferredName = requireNonBlank(fields.seniorPreferredName, "Senior's name");
  }
  if (fields.seniorFullName !== undefined) patch.seniorFullName = fields.seniorFullName;
  if (fields.timezone !== undefined) {
    patch.timezone = requireTimezone(fields.timezone);
    if (patch.timezone !== household.timezone) {
      await ctx.db.patch(householdId, { lastDigestDate: undefined });
      await resyncHouseholdTimezone(ctx, actor, householdId, patch.timezone, Date.now());
    }
  }
  if (fields.digestTime !== undefined) {
    assertTime(fields.digestTime, "Digest time");
    patch.digestTime = fields.digestTime;
  }
  if (fields.eventNoticeTime !== undefined) {
    assertTime(fields.eventNoticeTime, "Event notice time");
    patch.eventNoticeTime = fields.eventNoticeTime;
  }
  if (fields.shareTranscripts !== undefined) patch.shareTranscripts = fields.shareTranscripts;
  if (fields.backgroundPaused !== undefined) patch.backgroundPaused = fields.backgroundPaused;
  if (fields.weatherLocation !== undefined) {
    patch.weatherLocation = cleanOptional(
      fields.weatherLocation,
      MAX_WEATHER_LOCATION_LENGTH,
      "Weather location",
    );
  }

  await ctx.db.patch(householdId, patch);
  const changed = Object.fromEntries(
    Object.entries(patch).filter(([key, value]) => household[key as keyof typeof patch] !== value),
  );
  if (Object.keys(changed).length > 0) {
    await audit(ctx, {
      householdId,
      actor,
      action: "update_settings",
      entity: "household",
      entityId: householdId,
      detail: Object.fromEntries(Object.keys(changed).map((k) => [k, changed[k] ?? null])),
    });
  }
  const resumed = fields.backgroundPaused === false && household.backgroundPaused;
  if (
    resumed ||
    (patch.timezone !== undefined && patch.timezone !== household.timezone) ||
    (patch.eventNoticeTime !== undefined && patch.eventNoticeTime !== household.eventNoticeTime) ||
    (patch.seniorPreferredName !== undefined &&
      patch.seniorPreferredName !== household.seniorPreferredName)
  ) {
    await resyncHouseholdCalendars(ctx, householdId);
  }
  return await loadHousehold(ctx, householdId);
}
