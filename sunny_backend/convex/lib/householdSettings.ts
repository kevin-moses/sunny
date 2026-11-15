// lib/householdSettings.ts
// Purpose: The rules for changing a household's settings, shared by households.update (the app)
// and the household agent's update_settings tool (lib/agentSetupTools.ts), so a setting changed
// in the chat passes exactly the checks of the app: updateHouseholdCore, the settings fields it
// accepts, and the timezone and "HH:MM" checks households.create also uses. Kept out of
// households.ts so the agent's tools do not import that module's functions (and phone.ts, which
// it re-exports).
//
// Last modified: 2026-11-14

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

/** Longest weather location, in characters. */
const MAX_WEATHER_LOCATION_LENGTH = 100;

/**
 * purpose: Validate an IANA timezone and return its canonical spelling.
 * @param timezone: (string) Candidate zone.
 * @return: (string) Canonical zone, e.g. "America/New_York" for "america/new_york".
 * @raises invalid when the zone is not a usable region zone.
 */
export function requireTimezone(timezone: string): string {
  const canonical = canonicalTimezone(timezone);
  if (canonical === null) throw appError("invalid", `Unknown timezone ${timezone}`);
  return canonical;
}

/**
 * purpose: Reject a malformed "HH:MM" time.
 * @param time: (string) Candidate time.
 * @param label: (string) Field name for the error message.
 * @return: (void)
 */
function assertTime(time: string, label: string): void {
  if (!isLocalTime(time)) throw appError("invalid", `${label} must be HH:MM`);
}

/** The settings fields `update` and updateHouseholdCore accept (absent means unchanged). */
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

/** Changes to household settings: a key that is absent is unchanged. */
export type HouseholdSettingsChanges = ObjectType<typeof householdSettingsFields>;

/**
 * purpose: Core of update, shared with the household agent's settings tools
 *          (lib/agentSetupTools.ts update_settings): validate and apply settings changes. The
 *          caller has checked that the actor may edit the household (editors: primary or
 *          member). Rules: a non-blank senior name; a region timezone (a change resyncs the
 *          schedule and forgets the remembered digest date); digest and event notice times are
 *          local "HH:MM"; the weather location is trimmed, at most 100 characters, and blank clears
 *          it. A change that alters something is audited (update_settings, with the changed
 *          values), under the caregiver (for the agent, the caregiver it acts for). Google events
 *          are re-pushed when the zone, notice time or senior's name changes or a pause ends.
 * @param ctx: (MutationCtx) Context.
 * @param actor: (Actor) The editor caregiver, or the household agent acting for one.
 * @param householdId: (Id<"households">) Household.
 * @param fields: (HouseholdSettingsChanges) The changes.
 * @return: (Promise<Doc<"households">>) The household after the change, read back from the
 *          database.
 * @raises not_found for a missing household; invalid for any rule above.
 */
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
      // Write the zone first: the resync's expansion reads it from the household.
      // The digest's local date changes with the zone, so forget the remembered one.
      await ctx.db.patch(householdId, { timezone: patch.timezone, lastDigestDate: undefined });
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
      // An absent value (a cleared weather location) is recorded as null.
      detail: Object.fromEntries(Object.keys(changed).map((k) => [k, changed[k] ?? null])),
    });
  }
  // These three shape every Google event (zone, reminder minutes, description); resuming from
  // pause pushes everything the pause skipped.
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
  // Read back: a timezone change also cleared lastDigestDate, which the patch does not show.
  return await loadHousehold(ctx, householdId);
}
