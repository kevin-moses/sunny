// sunny_app/src/backend/__tests__/caregiverAuth.test.ts
//
// Purpose: Unit tests for caregiverAuth.ts: email and code validation, reading Clerk error
// codes (API errors and runtime errors), picking the email code factor, the sign-in to sign-up fallback decision, and the safe
// error messages.
//
// Last modified: 2026-10-31

import { describe, expect, it, jest } from '@jest/globals';

import { OFFLINE_ERROR_MESSAGE } from '../api';
import {
  cleanCode,
  clerkErrorCode,
  findEmailCodeFactorId,
  isCompleteCode,
  isValidEmail,
  normalizeEmail,
  shouldFallBackToSignUp,
  signInErrorMessage,
  SIGN_IN_FALLBACK_MESSAGE,
} from '../caregiverAuth';

jest.mock('../convex', () => ({ convex: {} }));

/**
 * purpose: Build an error shaped like a Clerk API response error.
 * @param code: (string) The first entry's code.
 * @param message: (string) The first entry's short message.
 * @param longMessage: (string | undefined) The first entry's long message.
 * @return: (Error) The error with an `errors` array.
 */
function clerkError(code: string, message: string, longMessage?: string): Error {
  return Object.assign(new Error(message), { errors: [{ code, message, longMessage }] });
}

describe('isValidEmail', () => {
  it('accepts ordinary addresses, trimming whitespace', () => {
    expect(isValidEmail('anna@example.com')).toBe(true);
    expect(isValidEmail('  anna.b+sunny@mail.example.co  ')).toBe(true);
  });

  it('rejects empty, spaced and malformed addresses', () => {
    for (const bad of ['', '   ', 'anna', 'anna@', '@example.com', 'anna@example', 'a b@c.de']) {
      expect(isValidEmail(bad)).toBe(false);
    }
  });
});

describe('normalizeEmail', () => {
  it('trims surrounding whitespace only', () => {
    expect(normalizeEmail('  Anna@Example.com ')).toBe('Anna@Example.com');
  });
});

describe('cleanCode and isCompleteCode', () => {
  it('keeps digits only, at most six', () => {
    expect(cleanCode('12 34-56')).toBe('123456');
    expect(cleanCode('1234567890')).toBe('123456');
    expect(cleanCode('abc')).toBe('');
  });

  it('is complete only with exactly six digits', () => {
    expect(isCompleteCode('123456')).toBe(true);
    expect(isCompleteCode('123 456')).toBe(true);
    expect(isCompleteCode('12345')).toBe(false);
    expect(isCompleteCode('')).toBe(false);
  });
});

describe('clerkErrorCode', () => {
  it('reads the first entry of a Clerk API error', () => {
    expect(clerkErrorCode(clerkError('form_code_incorrect', 'Incorrect code'))).toBe(
      'form_code_incorrect',
    );
  });

  it('reads the code of a Clerk runtime error', () => {
    expect(clerkErrorCode(Object.assign(new Error('offline'), { code: 'network_error' }))).toBe(
      'network_error',
    );
  });

  it('is null for anything else', () => {
    for (const value of [null, undefined, 'boom', new Error('x'), { errors: [] }, { errors: 3 }]) {
      expect(clerkErrorCode(value)).toBeNull();
    }
  });
});

describe('shouldFallBackToSignUp', () => {
  it('is true only when Clerk reports the identifier was not found', () => {
    expect(shouldFallBackToSignUp(clerkError('form_identifier_not_found', 'x'))).toBe(true);
    expect(shouldFallBackToSignUp(clerkError('form_code_incorrect', 'x'))).toBe(false);
    expect(shouldFallBackToSignUp(clerkError('too_many_requests', 'x'))).toBe(false);
    expect(shouldFallBackToSignUp(new Error('x'))).toBe(false);
    expect(shouldFallBackToSignUp(null)).toBe(false);
  });
});

describe('signInErrorMessage', () => {
  it('prefers the long message, then the message, of a Clerk error', () => {
    expect(signInErrorMessage(clerkError('c', 'Short', 'Longer explanation.'))).toBe(
      'Longer explanation.',
    );
    expect(signInErrorMessage(clerkError('c', 'Short'))).toBe('Short');
  });

  it('skips blank messages', () => {
    expect(signInErrorMessage(clerkError('c', '  ', ' '))).toBe(SIGN_IN_FALLBACK_MESSAGE);
  });

  it('gives the offline message for a Clerk network error', () => {
    const error = Object.assign(new Error('raw detail'), { code: 'network_error' });
    expect(signInErrorMessage(error)).toBe(OFFLINE_ERROR_MESSAGE);
  });

  it('never leaks an unrecognized error message', () => {
    expect(signInErrorMessage(new Error('TypeError at line 3'))).toBe(SIGN_IN_FALLBACK_MESSAGE);
    expect(signInErrorMessage('boom')).toBe(SIGN_IN_FALLBACK_MESSAGE);
  });
});

describe('findEmailCodeFactorId', () => {
  it('returns the email address id of the email_code factor', () => {
    const factors = [{ strategy: 'password' }, { strategy: 'email_code', emailAddressId: 'idn_1' }];
    expect(findEmailCodeFactorId(factors)).toBe('idn_1');
  });

  it('is null without an email_code factor or without factors', () => {
    expect(findEmailCodeFactorId([{ strategy: 'password' }])).toBeNull();
    expect(findEmailCodeFactorId([])).toBeNull();
    expect(findEmailCodeFactorId(null)).toBeNull();
  });
});
