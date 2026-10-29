// lib/secretBox.ts
// Purpose: Authenticated encryption for secrets stored in the database (Google refresh
// tokens and access tokens). AES-256-GCM via WebCrypto with a random 12-byte IV per message and
// the key from CALENDAR_TOKEN_KEY (base64 of 32 bytes). Output is "v1.<iv b64>.<ciphertext
// b64>"; any change to the string makes decryption fail. Errors are told apart so callers can
// react: ConfigError (lib/errors.ts) for a missing or malformed key, which no retry fixes, and
// SecretUnreadable for a box that cannot be opened (wrong key, tampering, unknown format).
// Key rotation: the box carries no key id, so changing CALENDAR_TOKEN_KEY makes every stored
// box unreadable and every caregiver must reconnect Google Calendar.
// Also home of constantTimeEqual, the one constant-time string compare (signatures, codes,
// keys).
// Exports: encryptSecret, decryptSecret, SecretUnreadable, constantTimeEqual.
//
// Last modified: 2026-10-29

import { fromBase64, toBase64 } from "./base64";
import { ConfigError } from "./errors";

const VERSION = "v1";
const IV_BYTES = 12;
const KEY_BYTES = 32;

/** A stored box that cannot be opened: wrong key, altered data or an unknown format. */
export class SecretUnreadable extends Error {
  /**
   * purpose: Build the error.
   * @param message: (string) Why the box could not be opened.
   */
  constructor(message: string) {
    super(message);
    this.name = "SecretUnreadable";
  }
}

/**
 * purpose: Import the AES key from CALENDAR_TOKEN_KEY.
 * @return: (Promise<Awaited<ReturnType<typeof crypto.subtle.importKey>>>) AES-GCM key.
 * @raises ConfigError when the variable is missing, not base64, or not 32 bytes.
 */
async function loadKey(): Promise<Awaited<ReturnType<typeof crypto.subtle.importKey>>> {
  const raw = process.env.CALENDAR_TOKEN_KEY;
  if (!raw) throw new ConfigError("Missing env var CALENDAR_TOKEN_KEY");
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = fromBase64(raw);
  } catch {
    throw new ConfigError("CALENDAR_TOKEN_KEY must be base64 of 32 bytes");
  }
  if (bytes.length !== KEY_BYTES) {
    throw new ConfigError("CALENDAR_TOKEN_KEY must be base64 of 32 bytes");
  }
  return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/**
 * purpose: Encrypt a secret for storage.
 * @param plain: (string) Secret text.
 * @return: (Promise<string>) "v1.<iv b64>.<ciphertext b64>".
 * @raises ConfigError when CALENDAR_TOKEN_KEY is missing or malformed.
 */
export async function encryptSecret(plain: string): Promise<string> {
  const key = await loadKey();
  const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(IV_BYTES)));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plain),
  );
  return `${VERSION}.${toBase64(iv)}.${toBase64(new Uint8Array(cipher))}`;
}

/**
 * purpose: Decrypt a string made by encryptSecret.
 * @param box: (string) "v1.<iv b64>.<ciphertext b64>".
 * @return: (Promise<string>) The original secret.
 * @raises SecretUnreadable when the format is unknown, the key is wrong or the data was
 *         altered; ConfigError when the key is missing or malformed.
 */
export async function decryptSecret(box: string): Promise<string> {
  const parts = box.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION) {
    throw new SecretUnreadable("Unrecognized secret format");
  }
  const key = await loadKey();
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(parts[1]!) },
      key,
      fromBase64(parts[2]!),
    );
    return new TextDecoder().decode(plain);
  } catch {
    throw new SecretUnreadable("Could not decrypt secret");
  }
}

/**
 * purpose: Compare two strings without leaking where they differ: every byte of the longer
 *          one is visited and a length difference counts as a mismatch.
 * @param a: (string) First string.
 * @param b: (string) Second string.
 * @return: (boolean) True when equal.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  }
  return diff === 0;
}
