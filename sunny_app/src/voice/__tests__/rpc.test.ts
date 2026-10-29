// sunny_app/src/voice/__tests__/rpc.test.ts
//
// Purpose: Unit tests for the phone RPC logic in rpc.ts: payload parsing, contact matching,
// and the findContact and sendMessage handlers with expo-contacts and expo-sms mocked.
//
// Last modified: 2026-10-28

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { RpcInvocationData } from 'livekit-client';

import { logger } from '../../logging/logger';
import {
  fullNameOf,
  handleFindContact,
  handleSendMessage,
  MAX_CONTACT_RESULTS,
  matchContacts,
  parseFindContactPayload,
  parseSendMessagePayload,
  registerPhoneRpcMethods,
  type RawContact,
} from '../rpc';

/** An async mock whose resolved value the tests choose per case. */
type AsyncMock = (...args: unknown[]) => Promise<unknown>;

const mockGetPermissions = jest.fn<AsyncMock>();
const mockRequestPermissions = jest.fn<AsyncMock>();
const mockGetAllDetails = jest.fn<AsyncMock>();
const mockIsAvailable = jest.fn<AsyncMock>();
const mockSendSms = jest.fn<AsyncMock>();

jest.mock('expo-contacts', () => ({
  ContactField: { GIVEN_NAME: 'givenName', FAMILY_NAME: 'familyName', PHONES: 'phones' },
  Contact: { getAllDetails: (...args: unknown[]) => mockGetAllDetails(...args) },
  getPermissionsAsync: () => mockGetPermissions(),
  requestPermissionsAsync: () => mockRequestPermissions(),
}));

jest.mock('expo-sms', () => ({
  isAvailableAsync: () => mockIsAvailable(),
  sendSMSAsync: (...args: unknown[]) => mockSendSms(...args),
}));

jest.mock('../../logging/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warning: jest.fn(), error: jest.fn() },
}));

const GRANTED = { granted: true, canAskAgain: true, status: 'granted' };

/**
 * purpose: Build an RPC invocation carrying a payload.
 * @param payload: (string) the raw payload
 * @return: (RpcInvocationData) the invocation
 */
function invocation(payload: string): RpcInvocationData {
  return { requestId: 'r1', callerIdentity: 'agent', payload, responseTimeout: 10000 };
}

/**
 * purpose: Build a RawContact with defaults.
 * @param overrides: (Partial<RawContact>) fields to override
 * @return: (RawContact) the contact
 */
function contact(overrides: Partial<RawContact> = {}): RawContact {
  return {
    id: 'c1',
    givenName: 'Ada',
    familyName: 'Lovelace',
    phoneNumbers: ['555-0100'],
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetPermissions.mockResolvedValue(GRANTED);
  mockIsAvailable.mockResolvedValue(true);
  mockSendSms.mockResolvedValue({ result: 'sent' });
});

describe('parseFindContactPayload', () => {
  it('returns the query string', () => {
    expect(parseFindContactPayload('{"query":"ada"}')).toBe('ada');
  });

  it('throws on malformed JSON', () => {
    expect(() => parseFindContactPayload('not json')).toThrow();
  });

  it('throws when the query is missing or not a string', () => {
    expect(() => parseFindContactPayload('{"query":5}')).toThrow();
    expect(() => parseFindContactPayload('[]')).toThrow();
  });
});

describe('fullNameOf and matchContacts', () => {
  it('trims the joined name when a part is empty', () => {
    expect(fullNameOf(contact({ familyName: '' }))).toBe('Ada');
  });

  it('matches case-insensitively on the full name substring', () => {
    const result = matchContacts([contact()], 'LACE');
    expect(result).toEqual([{ id: 'c1', name: 'Ada Lovelace', phone: '555-0100' }]);
  });

  it('matches across the given and family name boundary', () => {
    expect(matchContacts([contact()], 'a lov')).toHaveLength(1);
  });

  it('skips contacts without a phone number', () => {
    expect(matchContacts([contact({ phoneNumbers: [] })], 'ada')).toEqual([]);
  });

  it('uses the first phone number', () => {
    const result = matchContacts([contact({ phoneNumbers: ['1', '2'] })], 'ada');
    expect(result[0].phone).toBe('1');
  });

  it('names a nameless contact Unknown when the query is empty', () => {
    const nameless = contact({ givenName: '', familyName: '' });
    expect(matchContacts([nameless], '')[0].name).toBe('Unknown');
  });

  it('caps the results at MAX_CONTACT_RESULTS', () => {
    const many = Array.from({ length: 25 }, (_, i) => contact({ id: `c${i}` }));
    expect(matchContacts(many, 'ada')).toHaveLength(MAX_CONTACT_RESULTS);
  });

  it('returns nothing when no name matches', () => {
    expect(matchContacts([contact()], 'zzz')).toEqual([]);
  });
});

describe('parseSendMessagePayload', () => {
  it('returns the validated request', () => {
    const payload = JSON.stringify({ contactId: 'c1', phoneNumber: '555', message: 'hi' });
    expect(parseSendMessagePayload(payload)).toEqual({
      contactId: 'c1',
      phoneNumber: '555',
      message: 'hi',
    });
  });

  it('rejects an empty phone number', () => {
    expect(() => parseSendMessagePayload('{"phoneNumber":"","message":"hi"}')).toThrow(
      'Invalid phone number provided',
    );
  });

  it('rejects an empty message', () => {
    expect(() => parseSendMessagePayload('{"phoneNumber":"555","message":""}')).toThrow(
      'Message content cannot be empty',
    );
  });

  it('rejects a non-object payload', () => {
    expect(() => parseSendMessagePayload('"x"')).toThrow('Invalid message request');
  });
});

describe('handleFindContact', () => {
  const details = [
    { id: 'c1', givenName: 'Ada', familyName: 'Lovelace', phones: [{ number: '555-0100' }] },
    { id: 'c2', givenName: 'Adam', familyName: null, phones: [] },
  ];

  it('returns matching contacts as JSON', async () => {
    mockGetAllDetails.mockResolvedValue(details);
    const result = await handleFindContact(invocation('{"query":"ada"}'));
    expect(JSON.parse(result)).toEqual([{ id: 'c1', name: 'Ada Lovelace', phone: '555-0100' }]);
  });

  it('requests permission when not granted but askable', async () => {
    mockGetPermissions.mockResolvedValue({
      granted: false,
      canAskAgain: true,
      status: 'undetermined',
    });
    mockRequestPermissions.mockResolvedValue(GRANTED);
    mockGetAllDetails.mockResolvedValue(details);
    await handleFindContact(invocation('{"query":"ada"}'));
    expect(mockRequestPermissions).toHaveBeenCalledTimes(1);
  });

  it('returns an empty array for a blank query without reading contacts', async () => {
    expect(await handleFindContact(invocation('{"query":"   "}'))).toBe('[]');
    expect(await handleFindContact(invocation('{"query":""}'))).toBe('[]');
    expect(mockGetPermissions).not.toHaveBeenCalled();
    expect(mockGetAllDetails).not.toHaveBeenCalled();
  });

  it('does not log the query, names or the payload', async () => {
    mockGetAllDetails.mockResolvedValue(details);
    await handleFindContact(invocation('{"query":"ada"}'));
    const logged = JSON.stringify(
      [logger.info, logger.debug, logger.warning, logger.error].map(
        (fn) => (fn as jest.Mock).mock.calls,
      ),
    );
    expect(logged).not.toContain('ada');
    expect(logged).not.toContain('Lovelace');
    expect(logged).not.toContain('555-0100');
  });

  it('returns an empty array when permission is denied', async () => {
    mockGetPermissions.mockResolvedValue({ granted: false, canAskAgain: false, status: 'denied' });
    expect(await handleFindContact(invocation('{"query":"ada"}'))).toBe('[]');
    expect(mockGetAllDetails).not.toHaveBeenCalled();
  });

  it('returns an empty array on a malformed payload', async () => {
    expect(await handleFindContact(invocation('nope'))).toBe('[]');
  });

  it('returns an empty array when loading contacts fails', async () => {
    mockGetAllDetails.mockRejectedValue(new Error('boom'));
    expect(await handleFindContact(invocation('{"query":"ada"}'))).toBe('[]');
  });
});

describe('handleSendMessage', () => {
  const payload = JSON.stringify({ contactId: 'c1', phoneNumber: '555-0100', message: 'hello' });

  it('opens the composer and returns immediately without awaiting it', async () => {
    mockSendSms.mockReturnValue(new Promise(() => {}));
    const result = await handleSendMessage(invocation(payload));
    expect(result).toBe('Message composer opened for 555-0100');
    expect(mockSendSms).toHaveBeenCalledWith(['555-0100'], 'hello');
  });

  it('reports an error when SMS is unavailable', async () => {
    mockIsAvailable.mockResolvedValue(false);
    const result = await handleSendMessage(invocation(payload));
    expect(result).toBe('Error sending message: This device cannot send text messages');
    expect(mockSendSms).not.toHaveBeenCalled();
  });

  it('reports an error for an empty message', async () => {
    const empty = JSON.stringify({ contactId: 'c1', phoneNumber: '555', message: '' });
    expect(await handleSendMessage(invocation(empty))).toBe(
      'Error sending message: Message content cannot be empty',
    );
  });

  it('still returns success when the composer later rejects', async () => {
    mockSendSms.mockRejectedValue(new Error('composer failed'));
    const result = await handleSendMessage(invocation(payload));
    expect(result).toBe('Message composer opened for 555-0100');
  });
});

describe('registerPhoneRpcMethods', () => {
  it('registers both methods and unregisters them on cleanup', () => {
    const room = {
      registerRpcMethod: jest.fn(),
      unregisterRpcMethod: jest.fn(),
    };
    const cleanup = registerPhoneRpcMethods(room as never);
    expect(room.registerRpcMethod).toHaveBeenCalledWith('findContact', handleFindContact);
    expect(room.registerRpcMethod).toHaveBeenCalledWith('sendMessage', handleSendMessage);
    room.unregisterRpcMethod.mockClear();
    cleanup();
    expect(room.unregisterRpcMethod).toHaveBeenCalledTimes(2);
  });
});
