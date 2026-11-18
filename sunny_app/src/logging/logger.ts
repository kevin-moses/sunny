import type { Room } from 'livekit-client';

type LogLevel = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR';

type LogMetadata = Record<string, unknown>;

interface LogPayload {
  ts: string;
  level: LogLevel;
  component: string;
  message: string;
  metadata?: LogMetadata;
}

const LOG_TOPIC = 'ios.log';

const encoder = new TextEncoder();

let attachedRoom: Room | null = null;

export function attachLogRoom(room: Room): void {
  attachedRoom = room;
}

export function detachLogRoom(): void {
  attachedRoom = null;
}

function buildLogPayload(
  level: LogLevel,
  component: string,
  message: string,
  metadata?: LogMetadata,
): LogPayload {
  const payload: LogPayload = {
    ts: new Date().toISOString(),
    level,
    component,
    message,
  };
  if (metadata && Object.keys(metadata).length > 0) {
    payload.metadata = metadata;
  }
  return payload;
}

function writeToConsole(level: LogLevel, component: string, message: string): void {
  const line = `[${component}] ${message}`;
  if (level === 'DEBUG') console.debug(line);
  else if (level === 'INFO') console.info(line);
  else if (level === 'WARNING') console.warn(line);
  else console.error(line);
}

function forwardToRoom(payload: LogPayload): void {
  const room = attachedRoom;
  if (!room || String(room.state) !== 'connected') return;
  const data = encoder.encode(JSON.stringify(payload));
  room.localParticipant.publishData(data, { topic: LOG_TOPIC, reliable: false }).catch(() => {});
}

function emit(level: LogLevel, component: string, message: string, metadata?: LogMetadata): void {
  writeToConsole(level, component, message);
  forwardToRoom(buildLogPayload(level, component, message, metadata));
}

function makeLogger(
  level: LogLevel,
): (component: string, message: string, metadata?: LogMetadata) => void {
  return (component, message, metadata) => emit(level, component, message, metadata);
}

export const logger = {
  debug: makeLogger('DEBUG'),
  info: makeLogger('INFO'),
  warning: makeLogger('WARNING'),
  error: makeLogger('ERROR'),
};
