// esbuild fixture: bundle the shared entry (main + worker entries).
//
// esbuild (unlike vite/webpack) does not rewrite
// new URL("./worker.mjs", import.meta.url) into an emitted chunk — it
// leaves the expression untouched. The worker must therefore be built
// as a SEPARATE entry point whose output lands exactly where the
// client's relative URL expects it (same directory). This is the
// documented esbuild answer for workers; the library's bundler-neutral
// URL pattern is what makes the layout predictable.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const workerEntry = fileURLToPath(new URL(import.meta.resolve("leptonica-wasm/worker/worker.mjs")));

// Both outputs share dist/ so the client's new URL("./worker.mjs",
// import.meta.url) resolves against the emitted sibling at runtime.
await build({
  entryPoints: ["main.mjs"],
  bundle: true,
  format: "esm",
  platform: "browser",
  outfile: "dist/main.mjs",
});
await build({
  entryPoints: [workerEntry],
  bundle: true,
  format: "esm",
  platform: "browser",
  outfile: "dist/worker.mjs",
  // The emscripten loader probes for Node at runtime (ENVIRONMENT
  // detection) with a dynamic import("node:module") that browsers never
  // execute. esbuild still tries to resolve it; external keeps the
  // browser bundle free of Node builtins while the dead branch stays
  // dead at runtime.
  external: ["node:*"],
});
console.log("esbuild: bundled");
// The bundle targets the browser (DOM Worker path). Node cannot run
// that bundle; the CI browser matrix job loads it in a real browser.
// Here we only assert the build resolved every import (worker chunk
// included) — the runtime smoke for esbuild runs in the browser job.
