import { APIConnectionError, APIError } from "@typesafe-ai/sdk";
import { describe, expect, test } from "vitest";
import { ConfigError } from "./errors";
import { GoogleApiError } from "./google";
import { JevAnswerError, JevNotConfigured } from "./jevClient";
import { mailFailure, unavailableService } from "./mailFailure";

function jevStatus(status: number): APIError {
  return APIError.fromResponse(status, { detail: "refused" }, new Headers());
}

describe("mailFailure", () => {
  test("a missing TypeSafe key holds Jev", () => {
    expect(mailFailure(new JevNotConfigured("Missing env var TYPESAFE_API_KEY"))).toBe("jev_hold");
  });

  test("any other setting error holds the Google service of the job", () => {
    expect(mailFailure(new ConfigError("Missing env var GOOGLE_CLIENT_ID"))).toBe("hold");
    expect(mailFailure(new ConfigError("Missing env var CALENDAR_TOKEN_KEY"))).toBe("hold");
  });

  test.each([401, 403])("a Jev %i holds Jev", (status) => {
    expect(mailFailure(jevStatus(status))).toBe("jev_hold");
  });

  test.each([
    [400, "permanent"],
    [422, "permanent"],
    [408, "retry"],
    [429, "retry"],
    [503, "retry"],
  ])("a Jev %i is %s", (status, cause) => {
    expect(mailFailure(jevStatus(status))).toBe(cause);
  });

  test("a malformed Jev answer is permanent and a lost connection is retried", () => {
    expect(mailFailure(new JevAnswerError("no answer"))).toBe("permanent");
    expect(mailFailure(new APIConnectionError("reset"))).toBe("retry");
  });

  test("Google errors keep their Google cause and anything else is retried", () => {
    expect(mailFailure(new GoogleApiError(403, "insufficientPermissions"))).toBe("forbidden");
    expect(mailFailure(new Error("boom"))).toBe("retry");
  });
});

describe("unavailableService", () => {
  test.each([429, 500, 503])("a Jev %i says Jev is unavailable", (status) => {
    expect(unavailableService(jevStatus(status))).toBe("jev");
  });

  test("a lost Jev connection says Jev is unavailable", () => {
    expect(unavailableService(new APIConnectionError("reset"))).toBe("jev");
  });

  test.each([429, 500, 503])("a Google %i says Gmail is unavailable", (status) => {
    expect(unavailableService(new GoogleApiError(status, "Backend Error"))).toBe("gmail");
  });

  test.each([
    ["a Jev 408", jevStatus(408)],
    ["a Jev 422", jevStatus(422)],
    ["a Google 404", new GoogleApiError(404, "Not Found")],
    ["a Google 403 forbidden", new GoogleApiError(403, "insufficientPermissions")],
    ["a malformed Jev answer", new JevAnswerError("no answer")],
    ["any other error", new Error("boom")],
  ])("%s says nothing about a service", (_name, e) => {
    expect(unavailableService(e)).toBeNull();
  });
});
