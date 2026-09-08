import { defineConfig } from "vite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const packageRoot = new URL("../../", import.meta.url);
const packageJson = JSON.parse(
  readFileSync(new URL("package.json", packageRoot), "utf8"),
);
const browserWorkerExport = packageJson.exports["./worker"]?.default?.import;
if (typeof browserWorkerExport !== "string") {
  throw new Error("package.json is missing the ./worker default import export");
}
const browserWorkerEntry = fileURLToPath(new URL(browserWorkerExport, packageRoot));

// Serves the E2E page in dev mode; Playwright's webServer starts this.
// Vite does not resolve a package's own bare-name self-reference from this
// nested dev-server root. Resolve that exact specifier through package.json's
// browser/default export target instead. This keeps the browser test on the
// generated production adapter while the independent package and bundler
// gates remain responsible for consumer-side export resolution. Excluding the
// alias from dependency optimization also leaves its literal new Worker(new
// URL(...)) visible to Vite's worker transform.
export default defineConfig({
  root: new URL(".", import.meta.url).pathname,
  resolve: {
    alias: [
      { find: /^leptonica-wasm\/worker$/, replacement: browserWorkerEntry },
    ],
  },
  optimizeDeps: {
    exclude: ["leptonica-wasm/worker"],
  },
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
