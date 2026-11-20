import { describe, expect, test } from "vitest";
import { ConfigError } from "./errors";
import { GoogleApiError } from "./google";
import { googleFailure } from "./googleGrant";

const DAILY_LIMIT =
  '{"error":{"code":403,"errors":[{"domain":"usageLimits","reason":"dailyLimitExceeded","message":"Daily Limit Exceeded"}],"message":"Daily Limit Exceeded"}}';
const API_DISABLED =
  '{"error":{"code":403,"message":"Gmail API has not been used in project 123 before or it is disabled.","errors":[{"domain":"usageLimits","reason":"accessNotConfigured","message":"Gmail API has not been used in project 123 before or it is disabled."}],"status":"PERMISSION_DENIED"}}';
const DOMAIN_POLICY =
  '{"error":{"code":403,"errors":[{"domain":"global","reason":"domainPolicy","message":"The domain administrators have disabled Gmail apps."}],"message":"The domain administrators have disabled Gmail apps."}}';

describe.each(["mailboxes", "calendarConnections"] as const)("googleFailure for %s", (table) => {
  test.each([
    ["the daily project limit", DAILY_LIMIT],
    ["an API disabled for the project", API_DISABLED],
  ])("%s holds", (_name, body) => {
    expect(googleFailure(new GoogleApiError(403, body), table)).toEqual({ kind: "hold" });
  });

  test("a missing env var holds", () => {
    expect(googleFailure(new ConfigError("Missing env var GOOGLE_CLIENT_ID"), table)).toEqual({
      kind: "hold",
    });
  });

  test("a domain policy marks the row in error", () => {
    expect(googleFailure(new GoogleApiError(403, DOMAIN_POLICY), table)).toMatchObject({
      kind: "grant",
      status: "error",
    });
  });
});
