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

The wasm binary is resolved relative to its runtime module. Browser builds
must emit the worker entry as a separate bundle and copy the curated wasm next
to that worker. Full-ABI consumers must likewise copy the full-ABI wasm next
to their full-ABI entry. The independent-consumer gate verifies these URLs and
sidecar locations instead of assuming that a bundler rewrites them.
The package ships the raw escape hatch (dist/full-abi/) alongside
the curated build — every C symbol, loose types, zero ownership
semantics. Prefer the curated layer unless you need it.

## Installation and reproducibility

The supported compiler-free route is the package tarball attached to a GitHub
Release. It is built in CI from the pinned toolchain and can be installed
directly from the release asset URL:

```sh
pnpm add https://github.com/<owner>/<repo>/releases/download/<tag>/leptonica-wasm-<version>.tgz
```

The release consumer gate installs that tarball with dependency scripts
disabled, checks its manifest and source provenance, compiles every public
entry used by Node and browser consumers, bundles the browser entries, and
runs the Node worker path.

A fixed 40-character Git commit is a separate build-from-source route:

```sh
pnpm add github:<owner>/<repo>#<40-character-commit>
```

That route requires the repository's pinned Emscripten toolchain and explicit
approval of the exact Git dependency's build script. It is reproducibility
gated in CI, but it is not compiler-free. Mutable branches and tags, including
`main`, are not accepted by the fixed-commit consumer gate.

## Quick start — worker session (recommended)

```js
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
```

The same createSession works in Node — the "node" export condition
swaps in a worker_threads adapter; no code changes.

Long-running op holding close() hostage? session.terminate() kills
the worker outright — the whole wasm heap dies with it, every pending
request rejects.

A fatal WebAssembly trap is session-wide: every pending request rejects, all
RemotePix proxies are poisoned, and the client adapter terminates the Worker.
It is never surfaced as an ordinary recoverable operation error.

## Quick start — synchronous core

```js
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
```

## Quick start — raw escape hatch

```js
import { loadRaw } from "leptonica-wasm/raw";
import { readFile } from "node:fs/promises";

const wasmBinary = await readFile(
  "node_modules/leptonica-wasm/dist/full-abi/leptonica.wasm",
);
const { raw, memory } = await loadRaw({ wasmBinary });
const pix = raw._pixCreate(64, 64, 1);   // every C symbol, loose types
const slot = raw._malloc(4);              // pixDestroy takes PIX**, not PIX*:
new Int32Array(memory.buffer, slot, 1)[0] = pix;
raw._pixDestroy(slot);                    // ownership is yours
```

The raw layer ships the full ABI decode surface — that's the point.
You own every pointer; nothing is validated; upgrades can move symbols.

## API — worker session (leptonica-wasm/worker)

| API | Description |
| --- | --- |
| createSession(opts?) | Spawn worker + init wasm. opts.wasmPath overrides the binary location (CDN / self-host). |
| session.load(data, w, h) | RGBA → 32bpp RemotePix. Full ArrayBuffer views transfer directly; partial/shared views are copied exactly first. |
| session.run(pix, ops) | Run a chain (one round trip) → new RemotePix. |
| session.close() | Release every live Pix, poison session, tear down worker. Idempotent. |
| session.terminate() | Kill the worker outright (nuclear option). In-flight rejects. |
| pix.toPNG() / toJPEG(q) / toRGBA() | Encode/extract — bytes transfer back to this thread. |
| pix.toMask() | Extract a 1bpp Pix as compact, row-major, MSB-first bytes plus dimensions and stride. |
| pix.findSkew() / countPixels() / connComp() / histogram() / average() | Queries on the live handle. |

## API — chain ops (worker run and sync chain share the same set)

| Op | Depth | Description |
| --- | --- | --- |
| toGray(weights?) | 32→8 | RGB→gray. Default weights are perceptual (0.3/0.5/0.2) — deliberately not BT.601. |
| threshold(level) | 8→1 | Fixed-level threshold. |
| otsu({tile?, factor?}) | 8→1 | Otsu adaptive threshold. |
| sauvola(whsize, factor?) | 8→1 | Sauvola adaptive threshold (tiled). |
| cleanBackgroundToWhite(gamma, black, white) | 8/32→same | Normalize uneven background; all policy values are explicit. |
| sauvolaTiled(whsize, factor, nx, ny) | 8→1 | Native tiled Sauvola with an explicit grid. |
| selectByArea(area, connectivity, relation) | 1→1 | Keep components by `lt`/`gt`/`lte`/`gte` comparison against Leptonica's float32 area threshold. |
| maskOverColorPixels(thresholdDiff, minDistance) | 32→1 | Select pixels by RGB spread, with optional native erosion; over-image distances produce an empty mask without allocating a giant SEL. |
| deskew(reduction?) | any→same | Rotate to deskew (estimate via findSkew). |
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
wasm work happens. The new document-imaging primitives preserve Leptonica's
native domains rather than embedding a product profile: gamma must be positive,
Sauvola factor non-negative, area relation explicit, and color-mask distance is
a positive int32. Over-image erosion distances short-circuit to the equivalent
empty mask instead of allocating a giant SEL. Image/tile geometry that
Leptonica would silently rewrite is rejected.

## API — synchronous core (leptonica-wasm)

| API | Description |
| --- | --- |
| load() | Instantiate the wasm module → Leptonica. |
| lp.fromRGBA(data, w, h) | 32bpp Pix. |
| lp.chain(src) | ChainBuilder — record ops, run() executes. |
| lp.assertOwns(pix) | Cross-instance guard. |
| pix.width/height/depth | Live reads. |
| pix.toPNG() / toJPEG(q) / toRGBA() / toMask() | Encode/extract; returned bytes are JS-owned copies. |
| pix[Symbol.dispose]() | Release the handle, poison the wrapper. |

## Provenance & reproducibility

Every published wasm is built by GitHub Actions from the pinned
toolchain in vendor/versions.json (emsdk commit, dependency tags,
hashes) — never on a local machine. Distribution is via this repo's
GitHub Releases (npm publishing is disabled by design); each release
carries the package tarball, and the sha256 manifest inside it lets a
wasm be matched to the exact source pins.

Source-owned release variants and the public/private builder boundary are
documented in [docs/release-set-contract.md](docs/release-set-contract.md).

## License

BSD-2-Clause — see LICENSE. Leptonica copyright (2001) is preserved
alongside this package's bindings.
