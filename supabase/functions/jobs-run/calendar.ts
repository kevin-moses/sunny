// jobs-run/calendar.ts
// Purpose: The calendar_sync_event job: push one Sunny event to one caregiver's Sunny
// calendar in Google (create, replace or delete), and record the link and etag.
// Connections that are gone or revoked end the job quietly; revoked access marks the
// connection so the caregiver can reconnect. Rate limits and server errors are retried
// by the runner; a deleted Sunny calendar marks the connection in error. Access tokens
// are cached per connection while this function instance lives, so a burst of pushes
// (connecting a calendar queues one per event) refreshes the token once; a token Google
// rejects (401) is refreshed and the push retried once. Google event ids are derived from
// Sunny's event id, so a retried push replaces rather than duplicates.
//
// Last modified: 2026-10-27

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { rpc } from "../_shared/admin.ts";
import {
  buildGoogleEvent,
  deleteEvent,
  type EventSyncPayload,
  googleEventId,
  GoogleAccessRevoked,
  GoogleApiError,
  refreshAccessToken,
  upsertEvent,
} from "../_shared/google.ts";
import { type Job, type JobOutcome, PermanentJobError } from "./types.ts";

interface Credentials {
  connection_id: string;
  household_id: string;
  external_calendar_id: string;
  status: string;
  refresh_token: string;
}

/** Access tokens by connection id, kept until a minute before they expire. */
const tokenCache = new Map<string, { accessToken: string; expiresAt: number }>();

/**
 * purpose: An access token for a connection, from the cache or a fresh refresh.
 * @param creds: (Credentials) The connection and its refresh token.
 * @return: (Promise<string>) Access token.
 * @raises GoogleAccessRevoked when the caregiver revoked access.
 */
async function accessTokenFor(creds: Credentials): Promise<string> {
  const cached = tokenCache.get(creds.connection_id);
  if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.accessToken;
  const fresh = await refreshAccessToken(creds.refresh_token);
  tokenCache.set(creds.connection_id, fresh);
  return fresh.accessToken;
}

/**
 * purpose: Mark a connection revoked or in error.
 * @param db: (SupabaseClient) Service-role client.
 * @param connectionId: (string) Connection id.
 * @param status: ("revoked" | "error") New status.
 * @param reason: (string) What happened, shown to the caregiver later.
 */
async function markConnection(
  db: SupabaseClient,
  connectionId: string,
  status: "revoked" | "error",
  reason: string,
): Promise<void> {
  tokenCache.delete(connectionId);
  await rpc(db, "set_calendar_connection_status", {
    p_connection_id: connectionId,
    p_status: status,
    p_error: reason,
  });
}

/**
 * purpose: Push one event to one connection's Google calendar.
 * @param db: (SupabaseClient) Service-role client.
 * @param job: (Job) calendar_sync_event job; payload { event_id, connection_id }.
 * @return: (Promise<JobOutcome>) done with what happened (created/updated/deleted/skipped).
 */
export async function syncCalendarEvent(db: SupabaseClient, job: Job): Promise<JobOutcome> {
  const eventId = String(job.payload.event_id ?? "");
  const connectionId = String(job.payload.connection_id ?? "");
  const creds = await rpc<Credentials | null>(db, "get_calendar_credentials", { p_connection_id: connectionId });
  if (!creds || creds.status !== "active") {
    return { type: "done", result: { skipped: "connection not active" } };
  }
  if (creds.household_id !== job.household_id) {
    throw new PermanentJobError("Connection does not belong to the job's household");
  }
  const payload = await rpc<EventSyncPayload | null>(db, "get_event_sync_payload", {
    p_event_id: eventId,
    p_connection_id: connectionId,
  });
  if (!payload || payload.household_id !== job.household_id) {
    return { type: "done", result: { skipped: "event not found" } };
  }

  try {
    try {
      return await pushToGoogle(db, creds, payload, await accessTokenFor(creds));
    } catch (e) {
      if (!(e instanceof GoogleApiError && e.status === 401)) throw e;
      tokenCache.delete(connectionId); // stale cached token: refresh once and retry
      return await pushToGoogle(db, creds, payload, await accessTokenFor(creds));
    }
  } catch (e) {
    if (e instanceof GoogleAccessRevoked) {
      await markConnection(db, connectionId, "revoked", "Google access was revoked; reconnect Google Calendar.");
      return { type: "done", result: { skipped: "access revoked" } };
    }
    if (e instanceof GoogleApiError && e.gone) {
      await markConnection(db, connectionId, "error", "The Sunny calendar was deleted in Google; reconnect.");
      return { type: "done", result: { skipped: "calendar missing" } };
    }
    if (e instanceof GoogleApiError && !e.retryable && e.status !== 401 && e.status !== 403) {
      throw new PermanentJobError(e.message);
    }
    throw e;
  }
}

/**
 * purpose: Write one event to Google (or delete it when cancelled) and record the link.
 * @param db: (SupabaseClient) Service-role client.
 * @param creds: (Credentials) The connection.
 * @param payload: (EventSyncPayload) The event in Google's terms.
 * @param accessToken: (string) OAuth access token.
 * @return: (Promise<JobOutcome>) done with created/updated/deleted.
 */
async function pushToGoogle(
  db: SupabaseClient,
  creds: Credentials,
  payload: EventSyncPayload,
  accessToken: string,
): Promise<JobOutcome> {
  const googleId = googleEventId(payload.event_id);
  const now = new Date().toISOString();
  if (payload.cancelled) {
    await deleteEvent(accessToken, creds.external_calendar_id, payload.external_event_id ?? googleId);
    await db.from("calendar_event_links").delete()
      .eq("event_id", payload.event_id).eq("connection_id", creds.connection_id);
    return { type: "done", result: { action: "deleted" } };
  }
  const saved = await upsertEvent(accessToken, creds.external_calendar_id, googleId, buildGoogleEvent(payload));
  const [link] = await Promise.all([
    db.from("calendar_event_links").upsert({
      event_id: payload.event_id,
      connection_id: creds.connection_id,
      external_event_id: saved.id,
      etag: saved.etag,
      synced_at: now,
    }),
    db.from("calendar_connections").update({ last_synced_at: now }).eq("id", creds.connection_id),
  ]);
  if (link.error) throw new Error(`Could not save the event link: ${link.error.message}`);
  return { type: "done", result: { action: saved.created ? "created" : "updated", google_event_id: saved.id } };
}
