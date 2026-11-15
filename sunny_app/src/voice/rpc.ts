import type { Room, RpcInvocationData } from 'livekit-client';
import { Contact, ContactField, getPermissionsAsync, requestPermissionsAsync } from 'expo-contacts';
import * as SMS from 'expo-sms';

import { errorMessage } from '../errors';
import { logger } from '../logging/logger';

export const MAX_CONTACT_RESULTS = 10;

export interface RawContact {
  id: string;
  givenName: string;
  familyName: string;
  phoneNumbers: string[];
}

interface ContactResult {
  id: string;
  name: string;
  phone: string;
}

interface MessageRequest {
  contactId: string;
  phoneNumber: string;
  message: string;
}

function parseJsonObject(payload: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(payload);
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {}
  return null;
}

export function parseFindContactPayload(payload: string): string {
  const parsed = parseJsonObject(payload);
  if (!parsed || typeof parsed.query !== 'string') {
    throw new Error('findContact payload must be JSON with a string "query"');
  }
  return parsed.query;
}

export function fullNameOf(contact: RawContact): string {
  return `${contact.givenName} ${contact.familyName}`.trim();
}

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

async function ensureContactsPermission(): Promise<void> {
  let permission = await getPermissionsAsync();
  logger.debug('Contacts', `Authorization status: ${permission.status}`);
  if (!permission.granted && permission.canAskAgain) {
    permission = await requestPermissionsAsync();
  }
  if (!permission.granted) throw new Error('Access to contacts was denied');
}

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
