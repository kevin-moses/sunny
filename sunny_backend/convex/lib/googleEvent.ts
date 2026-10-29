// lib/googleEvent.ts
// STUB: minimal exports matching the part B contract so calendar sync (part C) compiles and
// its tests can mock this module. The lead replaces this file with part B's real mapping at
// merge. The real EventSyncPayload carries more fields; part C only reads `cancelled`.
//
// Last modified: 2026-10-29

import type { Doc } from "../_generated/dataModel";

/** An event in Google's terms, plus whether it is cancelled. */
export interface EventSyncPayload {
  cancelled: boolean;
  title: string;
}

/** The body sent to Google's events API. */
export interface GoogleEvent {
  summary: string;
}

/**
 * purpose: STUB. Build the sync payload for an event.
 * @param event: (Doc<"events">) Event.
 * @param _household: (Doc<"households">) Its household.
 * @return: (EventSyncPayload) Payload.
 */
export function eventSyncPayload(
  event: Doc<"events">,
  _household: Doc<"households">,
): EventSyncPayload {
  return { cancelled: event.deletedAt !== undefined, title: event.title };
}

/**
 * purpose: STUB. Build the Google event body.
 * @param p: (EventSyncPayload) Payload.
 * @return: (GoogleEvent) Body.
 */
export function buildGoogleEvent(p: EventSyncPayload): GoogleEvent {
  return { summary: p.title };
}

/**
 * purpose: STUB. The Google event id derived from a Sunny event id.
 * @param eventId: (string) Sunny event id.
 * @return: (string) Google-safe id.
 */
export function googleEventId(eventId: string): string {
  return eventId.toLowerCase().replace(/[^a-v0-9]/g, "");
}
