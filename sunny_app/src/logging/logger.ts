// sunny_app/src/logging/logger.ts
//
// Purpose: Structured logger for the Sunny app. Every entry is written to the JS console.
// While a LiveKit room is attached (attachLogRoom after the room connects, detachLogRoom
// when it drops) each entry is also published as compact JSON on the "ios.log" data topic,
// unreliable and fire-and-forget, so the agent re-emits it in the server terminal next to
// the Python log lines (sunny_agent/src/agent.py, _on_data_received). The agent's level map
// expects DEBUG, INFO, WARNING and ERROR; all four levels are forwarded.
//
// Usage:
//   logger.info('RPC', 'findContact called', { caller });
//   logger.error('Contacts', 'Access denied');
//
// Last modified: 2026-10-28

import type { Room } from 'livekit-client';

/** Level labels understood by the agent's ios.log handler. */
type LogLevel = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR';

/** Optional structured key-value pairs attached to a log entry. */
type LogMetadata = Record<string, unknown>;

/** The JSON object published on the ios.log topic. */
interface LogPayload {
  ts: string;
  level: LogLevel;
  component: string;
  message: string;
  metadata?: LogMetadata;
}

/** Data topic the agent listens on for forwarded app logs. */
const LOG_TOPIC = 'ios.log';

/** Encodes payloads for the data channel. */
const encoder = new TextEncoder();

/** The room log entries are forwarded to, or null when none is attached. */
let attachedRoom: Room | null = null;

/**
 * purpose: Bind a room so log entries are forwarded to the agent. Call once the room is
 *          created; entries are only sent while the room is actually connected.
 * @param room: (Room) the LiveKit room to publish log data on
 * @return: (void)
 */
export function attachLogRoom(room: Room): void {
  attachedRoom = room;
}

/**
 * purpose: Unbind the room so no further entries are forwarded.
 * @return: (void)
 */
export function detachLogRoom(): void {
  attachedRoom = null;
}

/**
 * purpose: Build the JSON payload the agent expects for one log entry.
 * @param level: (LogLevel) severity label
 * @param component: (string) short component name, without the "ios." prefix
 * @param message: (string) human-readable message
 * @param metadata: (LogMetadata | undefined) optional structured data; omitted when empty
 * @return: (LogPayload) the payload to serialize
 */
function buildLogPayload(
  level: LogLevel,
  component: string,
  message: string,
  metadata?: LogMetadata,
): LogPayload {
  const payload: LogPayload = {
    ts: new Date().toISOString(),
    level,
    component: `ios.${component}`,
    message,
  };
  if (metadata && Object.keys(metadata).length > 0) {
    payload.metadata = metadata;
  }
  return payload;
}

/**
 * purpose: Write an entry to the matching console method.
 * @param level: (LogLevel) severity label
 * @param component: (string) component name
 * @param message: (string) message text
 * @return: (void)
 */
function writeToConsole(level: LogLevel, component: string, message: string): void {
  const line = `[${component}] ${message}`;
  if (level === 'DEBUG') console.debug(line);
  else if (level === 'INFO') console.info(line);
  else if (level === 'WARNING') console.warn(line);
  else console.error(line);
}

/**
 * purpose: Publish an entry to the attached room if it is connected. Failures are
 *          swallowed on purpose: logging must never raise or recurse into logging.
 * @param payload: (LogPayload) the entry to publish
 * @return: (void)
 */
function forwardToRoom(payload: LogPayload): void {
  const room = attachedRoom;
  if (!room || String(room.state) !== 'connected') return;
  const data = encoder.encode(JSON.stringify(payload));
  room.localParticipant.publishData(data, { topic: LOG_TOPIC, reliable: false }).catch(() => {});
}

/**
 * purpose: Emit one entry to the console and, when a room is attached, to the agent.
 * @param level: (LogLevel) severity label
 * @param component: (string) component name
 * @param message: (string) message text
 * @param metadata: (LogMetadata | undefined) optional structured data
 * @return: (void)
 */
function emit(level: LogLevel, component: string, message: string, metadata?: LogMetadata): void {
  writeToConsole(level, component, message);
  forwardToRoom(buildLogPayload(level, component, message, metadata));
}

/**
 * purpose: Create the logging function for one severity level.
 * @param level: (LogLevel) severity label the entries carry
 * @return: ((component: string, message: string, metadata?: LogMetadata) => void) a function
 *          that logs an entry with a short component name such as "RPC", a human-readable
 *          message and optional structured data
 */
function makeLogger(
  level: LogLevel,
): (component: string, message: string, metadata?: LogMetadata) => void {
  return (component, message, metadata) => emit(level, component, message, metadata);
}

/** Logger entry points; each takes (component, message, metadata?). */
export const logger = {
  debug: makeLogger('DEBUG'),
  info: makeLogger('INFO'),
  warning: makeLogger('WARNING'),
  error: makeLogger('ERROR'),
};
