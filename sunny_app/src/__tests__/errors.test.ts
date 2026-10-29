// sunny_app/src/__tests__/errors.test.ts
//
// Purpose: Unit tests for errorMessage: Error messages, plain strings and the fallback.
//
// Last modified: 2026-10-28

import { describe, expect, it } from '@jest/globals';

import { errorMessage } from '../errors';

describe('errorMessage', () => {
  it('returns the message of an Error', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
  });

  it('returns a non-empty string as is', () => {
    expect(errorMessage('plain failure')).toBe('plain failure');
  });

  it('uses the default fallback for an Error without a message', () => {
    expect(errorMessage(new Error(''))).toBe('Something went wrong.');
  });

  it('uses the default fallback for other values', () => {
    expect(errorMessage(undefined)).toBe('Something went wrong.');
    expect(errorMessage({ code: 1 })).toBe('Something went wrong.');
  });

  it('uses a custom fallback when given', () => {
    expect(errorMessage(null, 'Request failed')).toBe('Request failed');
  });
});
