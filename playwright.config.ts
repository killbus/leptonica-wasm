import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  // The E2E needs dist/ artifacts (wasm + worker entry). CI runs it in
  // the ci job after the build; locally the same precondition applies
  // (zero-local-build discipline — dist comes from CI artifacts).
  webServer: {
    command: "pnpm exec vite --config tests/e2e/vite.config.mjs",
    url: "http://localhost:5179/",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  use: {
    baseURL: "http://localhost:5179",
  },
  // One browser is enough — the assertion is stack consistency
  // (Node vs browser), not cross-browser rendering.
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
  ],
});
