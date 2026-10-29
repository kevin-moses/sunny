// sunny_app/src/backend/__tests__/secureStorage.test.ts
//
// Purpose: Unit tests for the chunked SecureStore adapter: values above the per-item
// size limit round-trip across several keys, every stored item stays under the limit,
// shrinking a value deletes stale chunks, and remove clears everything.
//
// Last modified: 2026-10-28

import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { CHUNK_SIZE, secureStorage, splitIntoChunks } from '../secureStorage';

const mockStore = new Map<string, string>();
/** Keys passed to setItemAsync, in call order. */
const mockWrites: string[] = [];

jest.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 1,
  getItemAsync: async (key: string) => mockStore.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    mockWrites.push(key);
    mockStore.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    mockStore.delete(key);
  },
}));

beforeEach(() => {
  mockStore.clear();
  mockWrites.length = 0;
});

describe('splitIntoChunks', () => {
  it('returns one empty chunk for an empty value', () => {
    expect(splitIntoChunks('')).toEqual(['']);
  });

  it('splits at the chunk size', () => {
    const chunks = splitIntoChunks('a'.repeat(CHUNK_SIZE * 2 + 1));
    expect(chunks.map((chunk) => chunk.length)).toEqual([CHUNK_SIZE, CHUNK_SIZE, 1]);
  });
});

describe('secureStorage', () => {
  it('returns null for a missing key', async () => {
    expect(await secureStorage.getItem('k')).toBeNull();
  });

  it('round-trips a value larger than one chunk and keeps each item small', async () => {
    const value = 'x'.repeat(CHUNK_SIZE * 3 + 10);
    await secureStorage.setItem('k', value);
    expect(await secureStorage.getItem('k')).toBe(value);
    for (const item of mockStore.values()) expect(item.length).toBeLessThanOrEqual(CHUNK_SIZE);
  });

  it('deletes stale chunks when the value shrinks', async () => {
    await secureStorage.setItem('k', 'x'.repeat(CHUNK_SIZE * 3));
    await secureStorage.setItem('k', 'short');
    expect(await secureStorage.getItem('k')).toBe('short');
    expect([...mockStore.keys()].sort()).toEqual(['k.0', 'k.n']);
  });

  it('returns null when a chunk is missing', async () => {
    await secureStorage.setItem('k', 'x'.repeat(CHUNK_SIZE * 2));
    mockStore.delete('k.1');
    expect(await secureStorage.getItem('k')).toBeNull();
  });

  it('removes the count and every chunk', async () => {
    await secureStorage.setItem('k', 'x'.repeat(CHUNK_SIZE * 2));
    await secureStorage.removeItem('k');
    expect(mockStore.size).toBe(0);
    expect(await secureStorage.getItem('k')).toBeNull();
  });

  it('writes every chunk before the count', async () => {
    await secureStorage.setItem('k', 'x'.repeat(CHUNK_SIZE * 3));
    expect(mockWrites).toHaveLength(4);
    expect(mockWrites[mockWrites.length - 1]).toBe('k.n');
    expect(mockWrites.slice(0, 3).sort()).toEqual(['k.0', 'k.1', 'k.2']);
  });

  it('overwrites an existing value with the same number of chunks', async () => {
    await secureStorage.setItem('k', 'a'.repeat(CHUNK_SIZE * 2));
    await secureStorage.setItem('k', 'b'.repeat(CHUNK_SIZE * 2));
    expect(await secureStorage.getItem('k')).toBe('b'.repeat(CHUNK_SIZE * 2));
  });
});
