// lib/secretBox.ts
// Purpose: Authenticated encryption for secrets stored in the database (Google refresh
// tokens). AES-256-GCM via WebCrypto with a random 12-byte IV per message and the key from
// CALENDAR_TOKEN_KEY (base64 of 32 bytes). Output is "v1.<iv b64>.<ciphertext b64>"; any
// change to the string makes decryption fail.
// Exports: encryptSecret, decryptSecret.
//
// Last modified: 2026-10-29

const VERSION = "v1";
const IV_BYTES = 12;
const KEY_BYTES = 32;

/**
 * purpose: Standard base64 of bytes.
 * @param bytes: (Uint8Array) Input.
 * @return: (string) Base64 text.
 */
function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

/**
 * purpose: Bytes of a standard base64 string.
 * @param text: (string) Base64 text.
 * @return: (Uint8Array) Decoded bytes.
 * @raises Error when the text is not valid base64.
 */
function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

/**
 * purpose: Import the AES key from CALENDAR_TOKEN_KEY.
 * @return: (Promise<CryptoKey>) AES-GCM key.
 * @raises Error when the variable is missing, not base64, or not 32 bytes.
 */
async function loadKey(): Promise<CryptoKey> {
  const raw = process.env.CALENDAR_TOKEN_KEY;
  if (!raw) throw new Error("Missing env var CALENDAR_TOKEN_KEY");
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = fromBase64(raw);
  } catch {
    throw new Error("CALENDAR_TOKEN_KEY must be base64 of 32 bytes");
  }
  if (bytes.length !== KEY_BYTES) throw new Error("CALENDAR_TOKEN_KEY must be base64 of 32 bytes");
  return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/**
 * purpose: Encrypt a secret for storage.
 * @param plain: (string) Secret text.
 * @return: (Promise<string>) "v1.<iv b64>.<ciphertext b64>".
 * @raises Error when CALENDAR_TOKEN_KEY is missing or malformed.
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
 * @raises Error when the key is missing or wrong, the format is unknown, or the data was altered.
 */
export async function decryptSecret(box: string): Promise<string> {
  const parts = box.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION) throw new Error("Unrecognized secret format");
  const key = await loadKey();
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(parts[1]!) },
      key,
      fromBase64(parts[2]!),
    );
    return new TextDecoder().decode(plain);
  } catch {
    throw new Error("Could not decrypt secret");
  }
}
