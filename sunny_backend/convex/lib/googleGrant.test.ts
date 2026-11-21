import { describe, expect, test } from "vitest";
import { ConfigError } from "./errors";
import { GoogleAccessRevoked, GoogleApiError } from "./google";
import { googleFailure } from "./googleGrant";
import { SecretUnreadable } from "./secretBox";

const DAILY_LIMIT =
  '{"error":{"code":403,"errors":[{"domain":"usageLimits","reason":"dailyLimitExceeded","message":"Daily Limit Exceeded"}],"message":"Daily Limit Exceeded"}}';
const API_DISABLED =
  '{"error":{"code":403,"message":"Gmail API has not been used in project 123 before or it is disabled.","errors":[{"domain":"usageLimits","reason":"accessNotConfigured","message":"Gmail API has not been used in project 123 before or it is disabled."}],"status":"PERMISSION_DENIED"}}';
const DOMAIN_POLICY =
  '{"error":{"code":403,"errors":[{"domain":"global","reason":"domainPolicy","message":"The domain administrators have disabled Gmail apps."}],"message":"The domain administrators have disabled Gmail apps."}}';

describe("googleFailure", () => {
  test.each([
    ["the daily project limit", DAILY_LIMIT],
    ["an API disabled for the project", API_DISABLED],
  ])("%s holds", (_name, body) => {
    expect(googleFailure(new GoogleApiError(403, body))).toBe("hold");
  });

  test("a missing env var holds", () => {
    expect(googleFailure(new ConfigError("Missing env var GOOGLE_CLIENT_ID"))).toBe("hold");
  });

  test("a domain policy is forbidden", () => {
    expect(googleFailure(new GoogleApiError(403, DOMAIN_POLICY))).toBe("forbidden");
  });

  test.each([
    ["an unreadable saved sign-in", new SecretUnreadable("Could not decrypt secret"), "unreadable"],
    ["a revoked grant", new GoogleAccessRevoked("invalid_grant"), "revoked"],
    ["a 400", new GoogleApiError(400, "bad request"), "permanent"],
    ["a 401", new GoogleApiError(401, "expired"), "retry"],
    ["a 500", new GoogleApiError(500, "backend error"), "retry"],
    ["a per-user rate limit", new GoogleApiError(403, "userRateLimitExceeded"), "retry"],
  ])("%s is %s", (_name, error, cause) => {
    expect(googleFailure(error)).toBe(cause);
  });

  test("an error from outside Google is not classified", () => {
    expect(googleFailure(new Error("boom"))).toBeNull();
  });
});
