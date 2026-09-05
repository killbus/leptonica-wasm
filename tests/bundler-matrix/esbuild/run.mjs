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
import { copyFileSync } from "node:fs";
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

// esbuild leaves new URL("leptonica.wasm", import.meta.url) inside the
// emscripten loader untouched (it does not rewrite asset URLs) — the
// runtime fetches the wasm as a sibling of worker.mjs. Copy it there,
// or the worker 404s at init (the exact minefield this matrix guards).
const wasmPath = fileURLToPath(new URL(import.meta.resolve("leptonica-wasm/leptonica.wasm")));
copyFileSync(wasmPath, "dist/leptonica.wasm");

console.log("esbuild: bundled");
// The bundle targets the browser (DOM Worker path). Node cannot run
// that bundle, so this fixture is build-level: it asserts the build
// resolved every import (both entry points, worker chunk included)
// and emitted the sibling layout the client's relative URL expects.
// Browser runtime coverage for the bundled output lands with the M6
// Playwright E2E (implement.md M6); node-esm covers the runtime path
// here.
