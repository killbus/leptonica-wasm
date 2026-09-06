import { defineConfig } from "vite";

// Serves the E2E page in dev mode; Playwright's webServer starts this.
// The page imports "leptonica-wasm/worker" — vite resolves the package
// from this repo's node_modules (the bundler matrix proves the same
// resolution path at build level; here it runs for real in a browser).
export default defineConfig({
  root: new URL(".", import.meta.url).pathname,
  server: {
    port: 5179,
    strictPort: true,
  },
  // The page is an ES module entry served directly.
  build: {
    rollupOptions: {
      input: new URL("./page.mjs", import.meta.url).pathname,
    },
  },
});
