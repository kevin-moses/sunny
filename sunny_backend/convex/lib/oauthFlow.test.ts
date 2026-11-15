import { describe, expect, test } from "vitest";
import {
  FLOW_COOKIE,
  clearedFlowCookie,
  flowCookie,
  readFlowCookie,
  sha256Base64Url,
} from "./oauthFlow";

function withCookie(cookie: string | null): Request {
  return new Request("https://site.test/google/callback", {
    headers: cookie === null ? {} : { Cookie: cookie },
  });
}

describe("sha256Base64Url", () => {
  test("matches the RFC 7636 S256 example", async () => {
    expect(await sha256Base64Url("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });
});

describe("flow cookie", () => {
  test("is a host-only __Host- cookie: Secure, HttpOnly, SameSite=Lax, Path=/, ten minutes", () => {
    const cookie = flowCookie("v");
    expect(FLOW_COOKIE.startsWith("__Host-")).toBe(true);
    expect(cookie.split("; ").sort()).toEqual(
      [`${FLOW_COOKIE}=v`, "HttpOnly", "Max-Age=600", "Path=/", "SameSite=Lax", "Secure"].sort(),
    );
    expect(cookie).not.toContain("Domain");
  });

  test("clearing keeps the attributes and expires it", () => {
    expect(clearedFlowCookie().split("; ").sort()).toEqual(
      [`${FLOW_COOKIE}=`, "HttpOnly", "Max-Age=0", "Path=/", "SameSite=Lax", "Secure"].sort(),
    );
  });

  test("is read from among other cookies", () => {
    expect(readFlowCookie(withCookie(`a=1; ${FLOW_COOKIE}=abc_-; b=2`))).toBe("abc_-");
    expect(readFlowCookie(withCookie(`${FLOW_COOKIE}=x=y`))).toBe("x=y");
  });

  test("is null when absent, empty, or only a lookalike name", () => {
    expect(readFlowCookie(withCookie(null))).toBeNull();
    expect(readFlowCookie(withCookie(`${FLOW_COOKIE}=`))).toBeNull();
    expect(readFlowCookie(withCookie(`x${FLOW_COOKIE}=abc; sunny_google_flow=abc`))).toBeNull();
  });
});
