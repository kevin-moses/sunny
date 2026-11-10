// scripts/devGuard.test.ts
// Purpose: Tests for scripts/devGuard.ts: dotenv line parsing (export, quotes, comments) and the
// deployment decision in the Convex CLI's precedence: a shell variable beats .env.local, which
// beats .env; empty values are unset; a deploy key (or its CONVEX_DEPLOYMENT_TOKEN alias) wins
// over CONVEX_DEPLOYMENT; self-hosted targets and non-dev keys or deployments are refused.
//
// Last modified: 2026-11-09

import { describe, expect, test } from "vitest";
import { deploymentProblem, parseEnvFile } from "./devGuard";

const DEV = { CONVEX_DEPLOYMENT: "dev:example-dev-123" };

describe("parseEnvFile", () => {
  test("reads plain, exported, quoted and commented lines", () => {
    expect(
      parseEnvFile(
        [
          "# comment",
          "CONVEX_DEPLOYMENT=dev:abc # team: x",
          "export CONVEX_DEPLOY_KEY='prod:xyz|secret'",
          'CONVEX_URL="https://x.convex.cloud"',
          "not a line",
        ].join("\n"),
      ),
    ).toEqual({
      CONVEX_DEPLOYMENT: "dev:abc",
      CONVEX_DEPLOY_KEY: "prod:xyz|secret",
      CONVEX_URL: "https://x.convex.cloud",
    });
  });
});

describe("deploymentProblem", () => {
  test("accepts a dev deployment from .env.local", () => {
    expect(deploymentProblem([{}, DEV, {}])).toBeNull();
  });

  test("a shell CONVEX_DEPLOYMENT beats .env.local", () => {
    expect(deploymentProblem([{ CONVEX_DEPLOYMENT: "prod:live" }, DEV, {}])).toMatch(
      /not a dev deployment/,
    );
  });

  test("an empty shell value counts as unset", () => {
    expect(deploymentProblem([{ CONVEX_DEPLOYMENT: "" }, DEV, {}])).toBeNull();
  });

  test.each([
    ["the shell", [{ CONVEX_DEPLOY_KEY: "prod:live|secret" }, DEV, {}]],
    [".env.local", [{}, { ...DEV, CONVEX_DEPLOY_KEY: "prod:live|secret" }, {}]],
    [".env", [{}, DEV, { CONVEX_DEPLOY_KEY: "prod:live|secret" }]],
    ["the token alias", [{ CONVEX_DEPLOYMENT_TOKEN: "preview:x|secret" }, DEV, {}]],
  ])("refuses a non-dev deploy key from %s", (_label, sources) => {
    expect(deploymentProblem(sources)).toMatch(/not for a dev deployment/);
  });

  test("accepts a dev deploy key even with a prod CONVEX_DEPLOYMENT", () => {
    expect(
      deploymentProblem([{ CONVEX_DEPLOY_KEY: "dev:abc|secret", CONVEX_DEPLOYMENT: "prod:x" }]),
    ).toBeNull();
  });

  test("refuses self-hosted targets and a missing deployment", () => {
    expect(deploymentProblem([{ CONVEX_SELF_HOSTED_URL: "http://127.0.0.1:3210" }, DEV])).toMatch(
      /SELF_HOSTED/,
    );
    expect(deploymentProblem([{}, {}, {}])).toBe("CONVEX_DEPLOYMENT is not set");
  });

  test(".env is used only when .env.local and the shell leave it unset", () => {
    expect(deploymentProblem([{}, {}, { CONVEX_DEPLOYMENT: "prod:live" }])).toMatch(
      /not a dev deployment/,
    );
    expect(deploymentProblem([{}, DEV, { CONVEX_DEPLOYMENT: "prod:live" }])).toBeNull();
  });
});
