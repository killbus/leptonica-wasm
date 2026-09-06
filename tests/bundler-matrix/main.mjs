/**
 * Shared bundler-matrix entry (M5). Every fixture builds and runs THIS
 * file through its bundler/runner — the assertion is that the worker
 * session works from every consumption style, not that four different
 * programs work (design §5.3: bundler worker+wasm resolution is the
 * historical minefield, tesseract.js precedent).
 *
 * The entry is deliberately end-to-end: createSession → load → chain →
 * extract. node-esm executes it directly, so a broken worker entry or
 * a lost wasm binary fails at runtime there; the bundler fixtures
 * (vite/webpack5/esbuild) are build-level — they assert the bundler
 * resolved the worker entry and wasm into a correct output layout
 * (the historical minefield), with browser runtime coverage deferred
 * to the M6 Playwright E2E.
 */
import { createSession } from "leptonica-wasm/worker";

// Deterministic gradient, same shape as the consumer fixture.
function gradient(w, h) {
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = (i / 4) & 0xff;
    rgba[i + 1] = 255 - ((i / 4) & 0xff);
    rgba[i + 2] = 128;
    rgba[i + 3] = 255;
  }
  return rgba;
}

async function main() {
  const session = await createSession();
  try {
    const src = await session.load(gradient(32, 32), 32, 32);
    const out = await session.run(src, [
      { op: "toGray" },
      { op: "otsu", tile: 16 },
      { op: "dilate", w: 3, h: 3 },
    ]);
    const png = await out.toPNG();
    // PNG magic — the extract round trip came back with real bytes.
    if (png[0] !== 0x89 || png[1] !== 0x50 || png[2] !== 0x4e || png[3] !== 0x47) {
      throw new Error(`not a PNG: ${png[0]} ${png[1]} ${png[2]} ${png[3]}`);
    }
    const count = await out.countPixels();
    if (count <= 0) throw new Error(`empty countPixels: ${count}`);
    console.log(`bundler-matrix ok (png ${png.length}B, on-pixels ${count})`);
  } finally {
    await session.close();
  }
}

main().catch((err) => {
  console.error(err);
  throw err; // Node: unhandled rejection exits 1; browser: surfaces in console.
});
