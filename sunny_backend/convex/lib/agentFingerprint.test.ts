// lib/agentFingerprint.test.ts
// Purpose: Tests for lib/agentFingerprint.ts: the FNV-1a hash (known values, fixed width), and
// that the config fingerprint is stable and changes with the model, prompt or tools.
//
// Last modified: 2026-11-01

import { describe, expect, test } from "vitest";
import { AGENT_CONFIG_FINGERPRINT, fingerprintAgentConfig, fnv1a } from "./agentFingerprint";

describe("fnv1a", () => {
  test("matches the published 32-bit FNV-1a values", () => {
    expect(fnv1a("")).toBe("811c9dc5");
    expect(fnv1a("a")).toBe("e40c292c");
  });

  test("is always eight hex digits", () => {
    expect(fnv1a("hello world")).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("fingerprintAgentConfig", () => {
  const base = fingerprintAgentConfig("m", "prompt", [{ name: "t" }]);

  test("is stable for the same config", () => {
    expect(fingerprintAgentConfig("m", "prompt", [{ name: "t" }])).toBe(base);
  });

  test.each([
    ["model", fingerprintAgentConfig("m2", "prompt", [{ name: "t" }])],
    ["prompt", fingerprintAgentConfig("m", "prompt2", [{ name: "t" }])],
    ["tools", fingerprintAgentConfig("m", "prompt", [{ name: "t2" }])],
  ])("changes when the %s changes", (_what, other) => {
    expect(other).not.toBe(base);
  });

  test("the deployed fingerprint is a hash string", () => {
    expect(AGENT_CONFIG_FINGERPRINT).toMatch(/^[0-9a-f]{8}$/);
  });
});
