// lib/base64.ts
// Purpose: Base64 and base64url conversion between bytes and text, shared by the Google
// client (signed OAuth state, id token claims) and secretBox (AES-GCM iv and ciphertext).
// Exports: toBase64, fromBase64, toBase64Url (no padding), fromBase64Url (padding optional).
//
// Last modified: 2026-10-29

/**
 * purpose: Standard base64 of bytes.
 * @param bytes: (Uint8Array) Input bytes.
 * @return: (string) Base64 text with padding.
 */
export function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

/**
 * purpose: Bytes of a standard base64 string.
 * @param text: (string) Base64 text.
 * @return: (Uint8Array<ArrayBuffer>) Decoded bytes.
 * @raises Error when the text is not valid base64.
 */
export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

/**
 * purpose: Base64url of bytes, without padding.
 * @param bytes: (Uint8Array) Input bytes.
 * @return: (string) Base64url text.
 */
export function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * purpose: Bytes of a base64url string (padding optional).
 * @param text: (string) Base64url text.
 * @return: (Uint8Array<ArrayBuffer>) Decoded bytes.
 * @raises Error when the text is not valid base64.
 */
export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  return fromBase64(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "="));
}
