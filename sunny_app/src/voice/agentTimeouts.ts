// sunny_app/src/voice/agentTimeouts.ts
//
// Purpose: How long VoiceProvider lets LiveKit wait for the voice agent to join a room after
// connecting, per device. The phone waits AGENT_CONNECT_TIMEOUT_MS. The home display ends a
// session that has not reached the agent itself (its tuned start timeout, counted from the
// Talk press, at most DISPLAY_AGENT_CONNECT_TIMEOUT_MS), so LiveKit's wait there is that
// longest value and never fires first; the display's tuning takes its upper bound from here.
// No imports, so any layer can read these without pulling in LiveKit.
//
// Last modified: 2026-11-09

/** How long the phone waits for an agent to join after connecting, in milliseconds. */
export const AGENT_CONNECT_TIMEOUT_MS = 20_000;

/** The home display's agent connect wait, and the most its start timeout may be tuned to. */
export const DISPLAY_AGENT_CONNECT_TIMEOUT_MS = 60_000;
