// sunny_app/src/backend/secureStorage.ts
//
// Purpose: A supabase-js `storage` adapter backed by expo-secure-store (the iOS Keychain).
// Items are kept AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY (readable by background audio after
// the first unlock, never synced or restored to another device). SecureStore warns and may
// fail above about 2048 bytes per value and a Supabase session can exceed that, so each value is split across numbered chunk keys
// ("<key>.0", "<key>.1", ...) with the chunk count stored under "<key>.n". Stale chunks
// are deleted on every write and remove.
//
// Last modified: 2026-10-28

import * as SecureStore from 'expo-secure-store';

/** Largest number of characters stored in one SecureStore value (limit is ~2048 bytes). */
export const CHUNK_SIZE = 1800;

const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

/**
 * purpose: Key under which the chunk count of a value is stored.
 * @param key: (string) The logical storage key.
 * @return: (string) The SecureStore key for the chunk count.
 */
function countKey(key: string): string {
  return `${key}.n`;
}

/**
 * purpose: Key under which one chunk of a value is stored.
 * @param key: (string) The logical storage key.
 * @param index: (number) Zero-based chunk index.
 * @return: (string) The SecureStore key for that chunk.
 */
function chunkKey(key: string, index: number): string {
  return `${key}.${index}`;
}

/**
 * purpose: Split a string into chunks of at most CHUNK_SIZE characters.
 * @param value: (string) The value to split.
 * @return: (string[]) The chunks; an empty value yields one empty chunk.
 */
export function splitIntoChunks(value: string): string[] {
  const chunks: string[] = [];
  for (let start = 0; start < value.length; start += CHUNK_SIZE) {
    chunks.push(value.slice(start, start + CHUNK_SIZE));
  }
  return chunks.length > 0 ? chunks : [''];
}

/**
 * purpose: Read how many chunks are stored for a key.
 * @param key: (string) The logical storage key.
 * @return: (Promise<number>) The chunk count, or 0 when nothing (valid) is stored.
 */
async function readChunkCount(key: string): Promise<number> {
  const raw = await SecureStore.getItemAsync(countKey(key), OPTIONS);
  const count = raw === null ? 0 : Number.parseInt(raw, 10);
  return Number.isInteger(count) && count > 0 ? count : 0;
}

/**
 * purpose: Delete stored chunks from a given index up to a known count.
 * @param key: (string) The logical storage key.
 * @param fromIndex: (number) First chunk index to delete.
 * @param count: (number) The previous chunk count (exclusive upper bound).
 */
async function deleteChunks(key: string, fromIndex: number, count: number): Promise<void> {
  const indexes = Array.from({ length: Math.max(0, count - fromIndex) }, (_, i) => fromIndex + i);
  await Promise.all(
    indexes.map((index) => SecureStore.deleteItemAsync(chunkKey(key, index), OPTIONS)),
  );
}

/**
 * purpose: Read a chunked value.
 * @param key: (string) The logical storage key.
 * @return: (Promise<string | null>) The value, or null when absent or any chunk is missing.
 */
async function getItem(key: string): Promise<string | null> {
  const count = await readChunkCount(key);
  if (count === 0) return null;
  const parts = await Promise.all(
    Array.from({ length: count }, (_, index) =>
      SecureStore.getItemAsync(chunkKey(key, index), OPTIONS),
    ),
  );
  return parts.includes(null) ? null : parts.join('');
}

/**
 * purpose: Write a chunked value, then delete chunks left over from a longer earlier value.
 *          Chunks are written before the count so a reader never sees a count without data.
 * @param key: (string) The logical storage key.
 * @param value: (string) The value to store.
 */
async function setItem(key: string, value: string): Promise<void> {
  const previousCount = await readChunkCount(key);
  const chunks = splitIntoChunks(value);
  await Promise.all(
    chunks.map((chunk, index) => SecureStore.setItemAsync(chunkKey(key, index), chunk, OPTIONS)),
  );
  await SecureStore.setItemAsync(countKey(key), String(chunks.length), OPTIONS);
  await deleteChunks(key, chunks.length, previousCount);
}

/**
 * purpose: Remove a chunked value and all of its chunks.
 * @param key: (string) The logical storage key.
 */
async function removeItem(key: string): Promise<void> {
  const count = await readChunkCount(key);
  await SecureStore.deleteItemAsync(countKey(key), OPTIONS);
  await deleteChunks(key, 0, count);
}

/** The storage adapter handed to supabase-js (SupportedStorage). */
export const secureStorage = { getItem, setItem, removeItem };
