import { fromBase64, toBase64, toBase64Url } from "./base64";
import { ConfigError } from "./errors";

const VERSION = "v1";
const IV_BYTES = 12;
const KEY_BYTES = 32;
const RANDOM_TOKEN_BYTES = 32;

export class SecretUnreadable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretUnreadable";
  }
}

function loadKeyBytes(): Uint8Array<ArrayBuffer> {
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
  return bytes;
}

async function loadKey(): Promise<Awaited<ReturnType<typeof crypto.subtle.importKey>>> {
  return crypto.subtle.importKey("raw", loadKeyBytes(), { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function hmacHex(label: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const material = await crypto.subtle.importKey("raw", loadKeyBytes(), "HKDF", false, [
    "deriveKey",
  ]);
  const key = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode(label) },
    material,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
  return Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
}

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

export function randomToken(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(RANDOM_TOKEN_BYTES)));
}

export function constantTimeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  }
  return diff === 0;
}
