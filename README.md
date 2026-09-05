# leptonica-wasm

Modern ESM/WASM build of [Leptonica](https://github.com/DanBloomberg/leptonica)
— a curated set of image operators with a raw C-ABI escape hatch.

- **Worker sessions** — the main entry point. Pix handles live inside a
  worker (browser Worker / Node worker_threads); the main thread holds
  light proxies. Chains run as one round trip.
- **Synchronous core** — same operators, same arena, no worker.
- **Raw C-ABI** — every leptonica function, untyped, for what the
  curated layer doesn't cover. Documented danger: no semver, no
  ownership, no validation.

The wasm binary is fetched relative to the module — bundlers (vite,
webpack 5, esbuild) rewrite the worker entry and its wasm dependency
automatically (verified by the repo's bundler matrix).
The package ships the raw escape hatch (dist/full-abi/) alongside
the curated build — every C symbol, loose types, zero ownership
semantics. Prefer the curated layer unless you need it.

## Quick start — worker session (recommended)

\`\`\`js
import { createSession } from "leptonica-wasm/worker";

const session = await createSession();
try {
  // RGBA bytes (from canvas, PNG decode, etc.) — transferred, not copied.
  const pix = await session.load(rgbaBytes, width, height);
  const out = await session.run(pix, [
    { op: "toGray" },        // 32bpp → 8bpp
    { op: "otsu" },          // 8bpp → 1bpp (Otsu threshold)
    { op: "dilate", w: 3, h: 3 },
  ]);
  const pngBytes = await out.toPNG();
} finally {
  await session.close();    // releases every live Pix, poisons the session
}
\`\`\`

The same createSession works in Node — the "node" export condition
swaps in a worker_threads adapter; no code changes.

Long-running op holding close() hostage? session.terminate() kills
the worker outright — the whole wasm heap dies with it, every pending
request rejects.

## Quick start — synchronous core

\`\`\`js
import { load } from "leptonica-wasm";

const lp = await load();
const src = lp.fromRGBA(rgbaBytes, width, height);
const out = lp.chain(src)
  .toGray()
  .otsu()
  .dilate(3, 3)
  .run();
const pngBytes = out.toPNG();
src[Symbol.dispose](); out[Symbol.dispose]();   // explicit ownership (decision ④)
\`\`\`

## Quick start — raw escape hatch

\`\`\`js
import { loadRaw } from "leptonica-wasm/raw";
import { readFile } from "node:fs/promises";

const wasmBinary = await readFile(
  "node_modules/leptonica-wasm/dist/full-abi/leptonica.wasm",
);
const { raw, memory } = await loadRaw({ wasmBinary });
const pix = raw._pixCreate(64, 64, 1);   // every C symbol, loose types
raw._pixDestroy(pix);                    // ownership is yours
\`\`\`

The raw layer ships the full ABI decode surface — that's the point.
You own every pointer; nothing is validated; upgrades can move symbols.

## API — worker session (leptonica-wasm/worker)

| API | Description |
| --- | --- |
| createSession(opts?) | Spawn worker + init wasm. opts.wasmPath overrides the binary location (CDN / self-host). |
| session.load(data, w, h) | Transfer RGBA in → 32bpp RemotePix. Buffer is transferred, not copied. |
| session.run(pix, ops) | Run a chain (one round trip) → new RemotePix. |
| session.close() | Release every live Pix, poison session, tear down worker. Idempotent. |
| session.terminate() | Kill the worker outright (nuclear option). In-flight rejects. |
| pix.toPNG() / toJPEG(q) / toRGBA() | Encode/extract — bytes transfer back to this thread. |
| pix.findSkew() / countPixels() / connComp() / histogram() / average() | Queries on the live handle. |

## API — chain ops (worker run and sync chain share the same set)

| Op | Depth | Description |
| --- | --- | --- |
| toGray(weights?) | 32→8 | RGB→gray. Default weights are perceptual (0.3/0.5/0.2) — deliberately not BT.601. |
| threshold(level) | 8→1 | Fixed-level threshold. |
| otsu({tile?, factor?}) | 8→1 | Otsu adaptive threshold. |
| sauvola(whsize, factor?) | 8→1 | Sauvola adaptive threshold (tiled). |
| deskew(reduction?) | 1→1 | Rotate to deskew (estimate via findSkew). |
| rotate(angle, quality?) | any | radians; area (smooth) or shear (fast). |
| scale(fx, fy?) | any | Scale by factors. |
| shear(dir, angle) | any | Shear horizontally or vertically. |
| clip(x, y, w, h) | any | Crop. |
| translate(dx, dy) | any | Move. |
| dilate/erode/open/close(w, h) | 1 | Morphological ops with a rect sel. |
| or/and/xor(other) | 1 | Bitwise (1bpp both operands). |
| blend(other, frac) | 32 | Blend with a 32bpp operand. |
| addBorder(t, val?) | any | Add a border. |
| sobel(orientation?) | 8→8 | Edge detection. |

Depth is validated at record time — an invalid chain throws before any
wasm work happens.

## API — synchronous core (leptonica-wasm)

| API | Description |
| --- | --- |
| load() | Instantiate the wasm module → Leptonica. |
| lp.fromRGBA(data, w, h) | 32bpp Pix. |
| lp.chain(src) | ChainBuilder — record ops, run() executes. |
| lp.assertOwns(pix) | Cross-instance guard. |
| pix.width/height/depth | Live reads. |
| pix.toPNG() / toJPEG(q) / toRGBA() | Encode/extract. |
| pix[Symbol.dispose]() | Release the handle, poison the wrapper. |

## Provenance & reproducibility

Every published wasm is built by GitHub Actions from the pinned
toolchain in vendor/versions.json (emsdk commit, dependency tags,
hashes) — never on a local machine. The release artifact carries a
sha256 manifest so a wasm can be matched to the exact source pins even
after npm integrity stops caring.

## License

BSD-2-Clause — see LICENSE. Leptonica copyright (2001) is preserved
alongside this package's bindings.
