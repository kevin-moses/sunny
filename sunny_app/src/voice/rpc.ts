// sunny_app/src/voice/rpc.ts
//
// Purpose: Phone-side RPC methods the agent calls over LiveKit.
//   findContact: payload { query } -> JSON array [{ id, name, phone }] of contacts whose full
//     name contains the query (case-insensitive) and that have a phone number, at most
//     MAX_CONTACT_RESULTS (LiveKit RPC responses are limited to 15 KiB and the agent reads only
//     the first few). Returns "[]" for a blank query (without reading contacts) and on any
//     error, including denied contacts permission.
//   sendMessage: payload { contactId, phoneNumber, message } -> opens the system SMS
//     composer. The composer is started WITHOUT awaiting it, because the agent's RPC times
//     out after 10 seconds and the composer stays open until the user acts; the eventual
//     result is only logged. Validation failures return "Error sending message: <reason>".
// The parsing and matching logic is pure and exported for unit tests. Handlers are
// registered once per Room (registerPhoneRpcMethods); the handlers live in the room's RPC
// table, which persists across connects, so they are ready before any agent joins.
// Logs are forwarded to the agent's server logs, so they carry only lengths and counts, never
// message bodies, phone numbers, contact names or the search query.
//
// Last modified: 2026-10-28

import type { Room, RpcInvocationData } from 'livekit-client';
import { Contact, ContactField, getPermissionsAsync, requestPermissionsAsync } from 'expo-contacts';
import * as SMS from 'expo-sms';

import { errorMessage } from '../errors';
import { logger } from '../logging/logger';

/** Most contacts findContact returns (RPC responses are limited to 15 KiB). */
export const MAX_CONTACT_RESULTS = 10;

/** A contact reduced to the fields needed for name matching and replying. */
export interface RawContact {
  id: string;
  givenName: string;
  familyName: string;
  phoneNumbers: string[];
}

/** One entry of the findContact response. */
interface ContactResult {
  id: string;
  name: string;
  phone: string;
}

/** A validated sendMessage payload. */
interface MessageRequest {
  contactId: string;
  phoneNumber: string;
  message: string;
}

/**
 * purpose: Parse a JSON payload into an object, returning null when it is not a JSON object.
 * @param payload: (string) raw RPC payload
 * @return: (Record<string, unknown> | null) the parsed object or null
 */
function parseJsonObject(payload: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(payload);
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // Fall through: malformed JSON is reported as null.
  }
  return null;
}

/**
 * purpose: Extract the search query from a findContact payload.
 * @param payload: (string) raw RPC payload, expected to be JSON { query: string }
 * @return: (string) the query
 * @throws: Error when the payload is not JSON or has no string query
 */
export function parseFindContactPayload(payload: string): string {
  const parsed = parseJsonObject(payload);
  if (!parsed || typeof parsed.query !== 'string') {
    throw new Error('findContact payload must be JSON with a string "query"');
  }
  return parsed.query;
}

/**
 * purpose: Build a contact's full name (given + family, trimmed).
 * @param contact: (RawContact) the contact
 * @return: (string) the trimmed full name, possibly empty
 */
export function fullNameOf(contact: RawContact): string {
  return `${contact.givenName} ${contact.familyName}`.trim();
}

/**
 * purpose: Select contacts whose full name contains the query (case-insensitive) and that
 *          have at least one phone number, shaped for the findContact response. Stops at
 *          MAX_CONTACT_RESULTS matches.
 * @param contacts: (RawContact[]) all contacts on the device
 * @param query: (string) the search text
 * @return: (ContactResult[]) up to MAX_CONTACT_RESULTS matches, name "Unknown" when the contact has no name
 */
export function matchContacts(contacts: RawContact[], query: string): ContactResult[] {
  const needle = query.toLowerCase();
  const results: ContactResult[] = [];
  for (const contact of contacts) {
    const name = fullNameOf(contact);
    if (!name.toLowerCase().includes(needle)) continue;
    const phone = contact.phoneNumbers[0];
    if (!phone) continue;
    results.push({ id: contact.id, name: name === '' ? 'Unknown' : name, phone });
    if (results.length >= MAX_CONTACT_RESULTS) break;
  }
  return results;
}

/**
 * purpose: Validate a sendMessage payload.
 * @param payload: (string) raw RPC payload, expected JSON { contactId, phoneNumber, message }
 * @return: (MessageRequest) the validated request
 * @throws: Error with a user-facing reason when a field is missing or empty
 */
export function parseSendMessagePayload(payload: string): MessageRequest {
  const parsed = parseJsonObject(payload);
  if (!parsed) throw new Error('Invalid message request');
  const phoneNumber = typeof parsed.phoneNumber === 'string' ? parsed.phoneNumber : '';
  const message = typeof parsed.message === 'string' ? parsed.message : '';
  if (phoneNumber === '') throw new Error('Invalid phone number provided');
  if (message === '') throw new Error('Message content cannot be empty');
  const contactId = typeof parsed.contactId === 'string' ? parsed.contactId : '';
  return { contactId, phoneNumber, message };
}

/**
 * purpose: Make sure contacts permission is granted, asking once if it is undetermined.
 * @return: (Promise<void>) resolves when access is granted
 * @throws: Error when access is denied or restricted
 */
async function ensureContactsPermission(): Promise<void> {
  let permission = await getPermissionsAsync();
  logger.debug('Contacts', `Authorization status: ${permission.status}`);
  if (!permission.granted && permission.canAskAgain) {
    permission = await requestPermissionsAsync();
  }
  if (!permission.granted) throw new Error('Access to contacts was denied');
}

/**
 * purpose: Load every contact on the device with the fields needed for matching.
 * @return: (Promise<RawContact[]>) the contacts
 */
async function loadContacts(): Promise<RawContact[]> {
  const details = await Contact.getAllDetails([
    ContactField.GIVEN_NAME,
    ContactField.FAMILY_NAME,
    ContactField.PHONES,
  ]);
  return details.map((detail) => ({
    id: detail.id,
    givenName: detail.givenName ?? '',
    familyName: detail.familyName ?? '',
    phoneNumbers: (detail.phones ?? []).flatMap((phone) => (phone.number ? [phone.number] : [])),
  }));
}

/**
 * purpose: Handle the findContact RPC. Never throws; errors yield an empty list.
 * @param data: (RpcInvocationData) the RPC invocation
 * @return: (Promise<string>) JSON array of { id, name, phone } (at most MAX_CONTACT_RESULTS),
 *          or "[]" for a blank query or on any error
 */
export async function handleFindContact(data: RpcInvocationData): Promise<string> {
  logger.info('RPC', `findContact from: ${data.callerIdentity}`, {
    payload_length: data.payload.length,
  });
  try {
    const query = parseFindContactPayload(data.payload);
    if (query.trim() === '') return '[]';
    await ensureContactsPermission();
    const results = matchContacts(await loadContacts(), query.trim());
    logger.info('RPC', 'findContact success', {
      count: results.length,
      query_length: query.length,
    });
    return JSON.stringify(results);
  } catch (error) {
    logger.error('RPC', `findContact error: ${errorMessage(error)}`);
    return '[]';
  }
}

/**
 * purpose: Open the SMS composer without awaiting it and log how it ends.
 * @param request: (MessageRequest) the validated message request
 * @return: (void)
 */
function startComposer(request: MessageRequest): void {
  SMS.sendSMSAsync([request.phoneNumber], request.message)
    .then(({ result }) => {
      if (result === 'sent') logger.info('Messages', 'Message sent successfully');
      else if (result === 'cancelled') logger.info('Messages', 'Message composition cancelled');
      else logger.warning('Messages', 'Unknown message result');
    })
    .catch((error: unknown) => {
      logger.error('Messages', `Message sending failed: ${errorMessage(error)}`);
    });
}

/**
 * purpose: Handle the sendMessage RPC. Validates, starts the composer and returns at once so
 *          the agent's 10 second RPC timeout is not consumed by the user composing.
 * @param data: (RpcInvocationData) the RPC invocation
 * @return: (Promise<string>) "Message composer opened for <phone>" or "Error sending message: <reason>"
 */
export async function handleSendMessage(data: RpcInvocationData): Promise<string> {
  logger.info('RPC', `sendMessage from: ${data.callerIdentity}`, {
    payload_length: data.payload.length,
  });
  try {
    const request = parseSendMessagePayload(data.payload);
    if (!(await SMS.isAvailableAsync())) throw new Error('This device cannot send text messages');
    logger.info('Messages', 'Preparing to send message', {
      message_length: request.message.length,
    });
    startComposer(request);
    logger.info('RPC', 'sendMessage success: composer opened');
    return `Message composer opened for ${request.phoneNumber}`;
  } catch (error) {
    const reason = errorMessage(error);
    logger.error('RPC', `sendMessage error: ${reason}`);
    return `Error sending message: ${reason}`;
  }
}

/**
 * purpose: Register findContact and sendMessage on a room, replacing any earlier handlers.
 * @param room: (Room) the LiveKit room the agent calls into
 * @return: (() => void) cleanup that unregisters both methods
 */
export function registerPhoneRpcMethods(room: Room): () => void {
  room.unregisterRpcMethod('findContact');
  room.unregisterRpcMethod('sendMessage');
  room.registerRpcMethod('findContact', handleFindContact);
  room.registerRpcMethod('sendMessage', handleSendMessage);
  return () => {
    room.unregisterRpcMethod('findContact');
    room.unregisterRpcMethod('sendMessage');
  };
}
