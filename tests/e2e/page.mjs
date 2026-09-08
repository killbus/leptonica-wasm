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

function maskPattern(w = 9, h = 3) {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const foreground = y === 0 || (y === 1 && x % 2 === 0);
      const value = foreground ? 0 : 255;
      const i = (y * w + x) * 4;
      rgba[i] = value;
      rgba[i + 1] = value;
      rgba[i + 2] = value;
      rgba[i + 3] = 255;
    }
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
    const maskSrc = await session.load(maskPattern(), 9, 3);
    const maskPix = await session.run(maskSrc, [{ op: "toGray" }, { op: "threshold", level: 128 }]);
    const mask = await maskPix.toMask();
    return {
      png: b64(png),
      count,
      mask: b64(mask.data),
      maskMeta: {
        width: mask.width,
        height: mask.height,
        strideBytes: mask.strideBytes,
        bitOrder: mask.bitOrder,
        foregroundBit: mask.foregroundBit,
      },
    };
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
