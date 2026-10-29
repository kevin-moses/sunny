// vitest.config.ts
// Purpose: Test runner config for the Convex backend. convex-test runs functions in the
// edge-runtime environment, which matches Convex's default (non-Node) runtime.
//
// Last modified: 2026-10-28

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "edge-runtime",
    server: { deps: { inline: ["convex-test"] } },
  },
});
