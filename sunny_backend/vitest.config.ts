// vitest.config.ts
// Purpose: Test runner config for the Convex backend. convex-test runs functions in the
// edge-runtime environment, which matches Convex's default (non-Node) runtime.
// The coverage block (v8) reports over convex/**/*.ts, excluding generated code, tests and
// test helpers; output goes to coverage/ (ignored by version control). No threshold is enforced.
//
// Last modified: 2026-10-29

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "edge-runtime",
    server: { deps: { inline: ["convex-test"] } },
    coverage: {
      provider: "v8",
      include: ["convex/**/*.ts"],
      exclude: ["convex/_generated/**", "**/*.test.ts", "**/*.helpers.ts"],
      reporter: ["text-summary", "json-summary"],
      reportsDirectory: "coverage",
    },
  },
});
