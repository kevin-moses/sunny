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
