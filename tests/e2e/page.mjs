/**
 * E2E browser page (M6): the exact chain the golden suite anchors —
 * gradient → toGray → otsu → dilate → PNG — run in a REAL browser
 * worker session. The PNG bytes ride back to the test via a window
 * hook; the Node reference comes from the same session API through
 * the worker_threads adapter.
 */
import { createSession } from "leptonica-wasm/worker";

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

const OPS = [
  { op: "toGray" },
  { op: "otsu", tile: 16 },
  { op: "dilate", w: 3, h: 3 },
];

async function runChain() {
  const session = await createSession();
  try {
    const src = await session.load(gradient(32, 32), 32, 32);
    const out = await session.run(src, OPS);
    const png = await out.toPNG();
    const count = await out.countPixels();
    return { png: b64(png), count };
  } finally {
    await session.close();
  }
}

function b64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

// The test waits for this hook.
window.__e2eResult = runChain()
  .then((r) => ({ ok: true, ...r }))
  .catch((err) => ({ ok: false, error: String(err && err.stack || err) }));
