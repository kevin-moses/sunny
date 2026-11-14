// lib/deviceToken.test.ts
// Purpose: Unit tests for the device token helpers (lib/deviceToken.ts): the token's format and
// randomness, the SHA-256 hex digest (a known vector, and that it never equals the token), and
// the Bearer header parser (accepts only a well-formed token in a Bearer header; missing,
// other schemes, extra parts, short, long, wrong prefix and bad characters are refused).
//
// Last modified: 2026-11-13

import { describe, expect, test } from "vitest";
import {
  DEVICE_TOKEN_PREFIX,
  generateDeviceToken,
  hashDeviceToken,
  parseBearerToken,
} from "./deviceToken";

describe("generateDeviceToken", () => {
  test("is the prefix and 43 base64url characters (32 bytes)", () => {
    const token = generateDeviceToken();
    expect(token.startsWith(DEVICE_TOKEN_PREFIX)).toBe(true);
    expect(token).toMatch(/^sunny_dev_[A-Za-z0-9_-]{43}$/);
  });

  test("differs every time", () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generateDeviceToken()));
    expect(tokens.size).toBe(50);
  });
});

describe("hashDeviceToken", () => {
  test("is the lowercase hex SHA-256 of the text", async () => {
    expect(await hashDeviceToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  test("is stable for a token and never the token itself", async () => {
    const token = generateDeviceToken();
    const hash = await hashDeviceToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashDeviceToken(token)).toBe(hash);
    expect(hash).not.toContain(token.slice(DEVICE_TOKEN_PREFIX.length));
  });
});

describe("parseBearerToken", () => {
  const token = `sunny_dev_${"A".repeat(40)}-_9`;

  test("returns the token from a Bearer header, scheme case-insensitive", () => {
    expect(parseBearerToken(`Bearer ${token}`)).toBe(token);
    expect(parseBearerToken(`bearer ${token}`)).toBe(token);
    expect(parseBearerToken(`  Bearer   ${token}  `)).toBe(token);
  });

  test("refuses a missing header and other schemes", () => {
    expect(parseBearerToken(null)).toBeNull();
    expect(parseBearerToken("")).toBeNull();
    expect(parseBearerToken(token)).toBeNull();
    expect(parseBearerToken(`Basic ${token}`)).toBeNull();
    expect(parseBearerToken(`Bearer ${token} extra`)).toBeNull();
  });

  test("refuses malformed tokens", () => {
    expect(parseBearerToken("Bearer sunny_dev_short")).toBeNull();
    expect(parseBearerToken(`Bearer ${token}A`)).toBeNull();
    expect(parseBearerToken(`Bearer other_dev_${"A".repeat(43)}`)).toBeNull();
    expect(parseBearerToken(`Bearer sunny_dev_${"A".repeat(42)}=`)).toBeNull();
    expect(parseBearerToken(`Bearer sunny_dev_${"A".repeat(42)}+`)).toBeNull();
  });
});
