# General document-imaging bindings: design

Status: scope corrected on 2026-09-06 after first-principles boundary review.
The previously proposed documentClean API is superseded by this design.

## 1. Responsibility boundary

leptonica-wasm is a language/runtime bridge for Leptonica, not a pdfhow image
policy package. Its curated layer should make selected native operations safe,
discoverable, typed, and consistent across direct and worker use. It should not
choose which operations form a document-cleaning recipe.

The resulting dependency direction is:

    Leptonica native algorithms
        -> leptonica-wasm raw/full ABI
        -> leptonica-wasm curated safe primitives
        -> consumer-owned pipeline/profile (for example pdfhow)

The full ABI remains available to advanced callers. Curated coverage is not a
claim that unwrapped Leptonica functionality is unavailable; it is the stable,
resource-managed surface recommended for ordinary application code.

## 2. Public curated surface

Add these operations to the existing shared Op union and ChainBuilder:

| Operation | Native semantic | Required arguments | Output |
| --- | --- | --- | --- |
| cleanBackgroundToWhite | pixCleanBackgroundToWhite without optional masks | gamma, black, white | same depth, 8 or 32 bpp |
| sauvolaTiled | pixSauvolaBinarizeTiled | whsize, factor, nx, ny | 1 bpp |
| selectByArea | pixSelectByArea with an explicit native relation | thresholdArea, connectivity, relation | 1 bpp |
| maskOverColorPixels | pixMaskOverColorPixels | thresholdDiff, minDistance | 1 bpp |

All policy-bearing arguments are explicit. The API does not default to
pdfhow's area threshold, connectivity, Sauvola factor/window, tile size, color
thresholds, operation order, or deskew decision. Existing older operations
retain their compatibility defaults; this task does not retroactively redesign
them.

Add Pix.toMask() and RemotePix.toMask() as terminal extraction methods. They
return:

    interface PackedMask {
      data: Uint8Array;
      width: number;
      height: number;
      strideBytes: number;
      bitOrder: "msb-first";
      foregroundBit: 1;
    }

No Leptonica.documentClean method, worker documentClean message, built-in page
profile, implicit color overlay, or pipeline-specific cancellation protocol is
part of this package.

## 3. Primitive contracts

### cleanBackgroundToWhite

- Accept only non-colormapped 8 or 32 bpp Pix values.
- gamma is finite and greater than zero.
- black and white are int32 values satisfying black < white <= 200; negative
  black values remain valid because the native gamma-TRC contract permits them.
- The wrapper passes null for Leptonica's optional mask and grayscale inputs.
- The returned Pix is newly owned by the caller.

The commonly documented 1/70/190 values may appear in examples, but the
method requires callers to choose them explicitly.

### sauvolaTiled

- Accept only non-colormapped 8 bpp Pix values.
- whsize is an int32 value at least 2; factor is finite and non-negative.
- nx and ny are positive int32 values supplied by the caller.
- The image must be at least `2 * whsize + 3` in both dimensions and each
  requested tile must be at least `whsize + 2` in both dimensions.
- Native dimension/tile compatibility failures surface as operation failure;
  the binding does not silently change the grid or fall back to another
  thresholding algorithm.
- Only the binary output is requested; unused native outputs are null.

Existing sauvola() remains untiled and numerically unchanged.

### selectByArea

- Accept only 1 bpp Pix values.
- thresholdArea is finite, non-negative, and representable as Leptonica's
  native l_float32 threshold; the binding does not claim exact int32
  comparison semantics that the underlying API cannot provide.
- connectivity must be explicitly 4 or 8.
- relation must explicitly be `lt`, `gt`, `lte`, or `gte`, preserving all four
  native selection modes rather than fixing consumer policy in the binding.

### maskOverColorPixels

- Accept only non-colormapped 32 bpp Pix values.
- thresholdDiff is an int32 value in [0, 255].
- minDistance is a positive int32. If the implied centered erosion brick is
  larger than either image axis, the result is necessarily empty under
  Leptonica's default asymmetric erosion boundary. The binding returns that
  empty mask directly, preserving semantics without allocating a giant SEL.
  The curated module neither exposes nor calls resetMorphBoundaryCondition(),
  so this default is stable for instances created through the supported API.
- The result is a newly owned 1 bpp Pix.

### toMask

- Accept only 1 bpp input.
- Rows are top-to-bottom; the leftmost pixel is bit 7 of the first byte.
- strideBytes equals ceil(width / 8).
- 1 denotes an ON/foreground pixel and 0 denotes background.
- Unused low bits in each row's final byte are zero.
- The output length is exactly strideBytes multiplied by height.
- The returned Uint8Array owns ordinary JS memory and never aliases WASM.

Test widths 1, 7, 8, 9, 31, 32, and 33, plus empty/full/alternating rows and
multiple-row boundaries.

## 4. Ownership and failure model

Each native wrapper validates before allocating where practical. Every PIX*
returned to JavaScript is adopted exactly once by the existing Pix registry.
runChain owns each intermediate and destroys all non-final intermediates on
success and all created intermediates on failure.

PIX** outputs are initialized to null and destroyed even when Leptonica
returns an error after assigning an output. Native extraction buffers are
freed regardless of JavaScript allocation/copy success. JavaScript exceptions
must not unwind through C++ frames that still own native resources.

Returned PNG/JPEG/RGBA/mask arrays remain valid after Pix disposal and WASM
heap growth. A recoverable operation failure returns no live native output. A
fatal trap poisons the instance and becomes a terminal worker control signal;
it is not presented as an ordinary failed image operation. The worker-side
arena then rejects every queued or later request with the same fatal signal
without re-entering WASM. The client rejects all pending requests and owns the
platform-worker termination. This ordering avoids closing a DOM Worker before
its final fatal message becomes observable to the client. The browser runtime
test exercises the published `leptonica-wasm/worker` adapter with only its
Worker constructor redirected to the isolated instrumented entry, and verifies
that the adapter invokes the real platform `terminate()` exactly once. A second
delayed-teardown instance independently proves the worker-side terminal gate.
Initialization failures use the same idempotent session-retirement path, so an
`init` fatal response cannot trigger both session teardown and an adapter-level
second termination.
This is a fatal-trap guarantee, not a heartbeat or liveness guarantee for an
arbitrary DOM Worker that disappears without an error or terminal message.

Pix and RemotePix construction is owner-controlled. Public callers cannot
construct a curated wrapper around an arbitrary native handle or worker arena
id, and those handles are not exposed as mutable JavaScript properties. This
keeps registration, cross-instance checks, poisoning, and teardown on the only
supported creation paths. If an ordinary native destructor throws, the wrapper
remains poisoned because ownership is uncertain; Leptonica.close() still makes
a best-effort attempt to destroy the remaining live Pix values and then rethrows
the first destructor error. A fatal trap stops all further native destruction.

## 5. Worker parity

The worker transports the same generic Op objects used by the direct chain.
RemotePix.toMask() adds mask to the existing extraction format union. The
worker directly transfers a full JS-owned extraction ArrayBuffer. Partial or
SharedArrayBuffer-backed views use an exact-copy fallback before transfer.

The existing arena remains authoritative: externally visible RemotePix
handles live until session close, and there is no new per-object remote dispose
contract. This task does not add request-local pages because no product-level
single-call pipeline exists in this layer.

## 6. Raw and curated capability

The curated surface is intentionally incomplete relative to Leptonica. A
consumer can use functionality not represented in ChainBuilder through the raw
or full-ABI package entry, provided the symbol is included in that build and
the consumer manages pointers, return codes, and destruction correctly.

Curated bindings are selected when the repository is willing to maintain:

- stable JavaScript types and parameter meaning;
- depth and range validation;
- deterministic ownership and cleanup;
- main/worker parity where applicable; and
- package/export tests.

This distinction avoids turning one consumer's workflow into a permanent
library abstraction while preserving access to the underlying engine.

## 7. Package and consumer proof

The package generation order is:

    curated build -> full-ABI build -> declarations/worker wrappers
        -> export checks -> final hash manifest -> pack -> consumers

No manifested file may change after hashing. Validate all package exports and
assets under Node and browser/bundler conditions.

Gate A installs the exact release-candidate tarball in a fresh consumer/store
without compilation. Gate B installs a reachable fixed 40-character GitHub
commit in another fresh consumer/store and proves source preparation created
its own distribution with the pinned toolchain and explicit pnpm build-script
approval. Neither gate may use the worktree through a file dependency.

## 8. Tests and measurements

Native-oracle and target-WASM tests cover valid and invalid inputs, exact
connectivity/area semantics, multi-tile Sauvola, mask packing, JS copy failure,
partial native outputs, and repeated operation chains. Main and worker results
must match.

Resource tests separate live Leptonica allocations from WASM heap capacity,
JS heap, and process RSS. Run warm-up plus at least 100 sequential pages and
record per-page diagnostics. Missing runtime artifacts or skipped tests do not
constitute passing evidence.

The real-scan comparison lives in a consumer-side adapter or benchmark harness.
It may define a pdfhow profile such as background normalization followed by
grayscale, tiled Sauvola, four-connected area filtering, optional color
composition, and optional deskew. That profile and its defaults remain outside
the leptonica-wasm public contract.

Measure cold, first, and steady latency in ms/MP; mask and RGBA extraction;
single/multipage memory; raw/gzip package sizes; and quality/OCR or a declared
proxy. Record exact source commits, inputs, permissions, dimensions, parameters,
runtime, browser/device, and thread count.

## 9. Deferred work

- pdfhow's production adapter and final adoption decision.
- Any reusable higher-level companion package, which requires independent
  consumers and semantics beyond one product profile.
- Dewarp, pending target-WASM memory and quality measurements.
