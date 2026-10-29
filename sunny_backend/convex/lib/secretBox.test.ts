// lib/secretBox.test.ts
// Purpose: Tests for AES-256-GCM secret encryption: round trip, fresh IV per message, the
// versioned format, tampering, a wrong key, and a missing or malformed key; and the constant-time
// string compare.
//
// Last modified: 2026-10-29

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { constantTimeEqual, decryptSecret, encryptSecret } from "./secretBox";

/**
 * purpose: Base64 of 32 bytes all set to one value, as a test key.
 * @param byte: (number) Byte value.
 * @return: (string) Base64 key.
 */
function keyOf(byte: number): string {
  return btoa(String.fromCharCode(...new Uint8Array(32).fill(byte)));
}

const original = process.env.CALENDAR_TOKEN_KEY;

beforeEach(() => {
  process.env.CALENDAR_TOKEN_KEY = keyOf(7);
});

afterEach(() => {
  if (original === undefined) delete process.env.CALENDAR_TOKEN_KEY;
  else process.env.CALENDAR_TOKEN_KEY = original;
});

describe("secretBox", () => {
  test("round trips a secret", async () => {
    const box = await encryptSecret("1//refresh-token");
    expect(await decryptSecret(box)).toBe("1//refresh-token");
  });

  test("round trips non-ASCII text and the empty string", async () => {
    expect(await decryptSecret(await encryptSecret("café"))).toBe("café");
    expect(await decryptSecret(await encryptSecret(""))).toBe("");
  });

  test("output is versioned with a 12 byte IV", async () => {
    const [version, iv, cipher] = (await encryptSecret("x")).split(".");
    expect(version).toBe("v1");
    expect(atob(iv!).length).toBe(12);
    expect(cipher!.length).toBeGreaterThan(0);
  });

  test("uses a fresh IV for each message", async () => {
    expect(await encryptSecret("same")).not.toBe(await encryptSecret("same"));
  });

  test("tampered ciphertext fails to decrypt", async () => {
    const [v, iv, cipher] = (await encryptSecret("secret")).split(".");
    const bytes = Uint8Array.from(atob(cipher!), (c) => c.charCodeAt(0));
    bytes[0] = bytes[0]! ^ 1;
    const forged = `${v}.${iv}.${btoa(String.fromCharCode(...bytes))}`;
    await expect(decryptSecret(forged)).rejects.toThrow("Could not decrypt");
  });

  test("tampered IV fails to decrypt", async () => {
    const [v, iv, cipher] = (await encryptSecret("secret")).split(".");
    const bytes = Uint8Array.from(atob(iv!), (c) => c.charCodeAt(0));
    bytes[0] = bytes[0]! ^ 1;
    const forged = `${v}.${btoa(String.fromCharCode(...bytes))}.${cipher}`;
    await expect(decryptSecret(forged)).rejects.toThrow("Could not decrypt");
  });

  test("a different key fails to decrypt", async () => {
    const box = await encryptSecret("secret");
    process.env.CALENDAR_TOKEN_KEY = keyOf(8);
    await expect(decryptSecret(box)).rejects.toThrow("Could not decrypt");
  });

  test("rejects an unknown version or shape", async () => {
    await expect(decryptSecret("v2.aa.bb")).rejects.toThrow("Unrecognized");
    await expect(decryptSecret("garbage")).rejects.toThrow("Unrecognized");
  });

  test("malformed base64 in the box fails to decrypt", async () => {
    await expect(decryptSecret("v1.!!!.???")).rejects.toThrow("Could not decrypt");
  });

  test("missing key gives a clear error", async () => {
    delete process.env.CALENDAR_TOKEN_KEY;
    await expect(encryptSecret("x")).rejects.toThrow("Missing env var CALENDAR_TOKEN_KEY");
  });

  test("wrong length key gives a clear error", async () => {
    process.env.CALENDAR_TOKEN_KEY = btoa("too short");
    await expect(encryptSecret("x")).rejects.toThrow("32 bytes");
  });

  test("non-base64 key gives a clear error", async () => {
    process.env.CALENDAR_TOKEN_KEY = "!!!not base64!!!";
    await expect(encryptSecret("x")).rejects.toThrow("32 bytes");
  });
});

describe("constantTimeEqual", () => {
  test("compares by content and length", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
  });
});
