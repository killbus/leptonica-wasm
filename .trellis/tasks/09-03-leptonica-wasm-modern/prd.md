# Modern WebAssembly Build of Leptonica

## Goal

Deliver a reproducible, maintainable, ESM-first WebAssembly distribution of Leptonica with a curated TypeScript API, a full C-ABI escape hatch, a worker session client, browser and Node verification, and GitHub Release packaging.

## Product boundary

- This repository owns source pins, build logic, runtime bindings, TypeScript APIs, tests, release variants, and the public source-to-builder contract.
- The external builder owns its operating environment, private routing, candidate materialization, promotion, and provisioning guide.
- Private variant names, domains, seeds, and compile-time lock values remain source-owned and never enter the public dispatch payload.
- Registry publication is disabled. GitHub Release is the only distribution channel.

## Technical decisions

1. Build with pinned Emscripten, CMake, and Ninja; compile pinned zlib, libpng, libjpeg-turbo, and Leptonica sources without source patches.
2. Provide two API layers:
   - a curated, semver-governed TypeScript API;
   - a full-ABI escape hatch with intentionally loose types and explicit danger documentation.
3. Move RGBA bytes only at input and extraction boundaries. Intermediate images remain Leptonica handles so 1bpp semantics and memory efficiency are preserved.
4. Use explicit disposal and poisoned handles. FinalizationRegistry reports leaks but is not a release mechanism.
5. Keep PNG and JPEG write paths in the curated artifact. Image decoding remains outside the curated surface.
6. Ship the curated artifact by default and the full-ABI artifact as an explicit compatibility path. The M1 measurement showed approximately 105 KB gzip for the curated wasm and 855 KB gzip for the full ABI.
7. Use one WebAssembly instance per worker session. Image-level parallelism uses multiple workers and transferable ArrayBuffers; pthreads and SharedArrayBuffer are not required.
8. Use a chain builder so one recorded chain executes with one asynchronous session call.
9. Session ownership is arena-based: source and retained result handles may cross messages; intermediate handles never do; close releases the arena; terminate releases the worker process.
10. Generate and verify declarations, compare actual exports in CI, and validate package consumption with strict downstream fixtures.
11. Use a native Leptonica harness built from the same pins as an independent correctness oracle.
12. Keep release membership and compile-time locks in private source variant files while exposing only opaque public target identities.

## Requirements

### R1. Reproducible build

- Exact commits and tool versions are recorded in "vendor/versions.json".
- A clean CI job produces the curated ".wasm" and ESM glue plus the full-ABI artifact set.
- The cold-install path verifies every retained toolchain archive against its byte count and SHA-256 whitelist.
- Independent jobs compare generated artifacts byte for byte.
- Local development does not install or run the heavy toolchain.

### R2. Curated API

The curated API includes:

- "fromRGBA", "toRGBA", "toPNG", and "toJPEG";
- grayscale and depth conversion;
- thresholding, Otsu, and Sauvola binarization;
- skew detection and deskew;
- rotate, scale, shear, clip, and translate;
- dilate, erode, open, and close;
- connected components;
- pixel counts, grayscale histogram, and average statistics;
- Sobel edge filtering;
- OR, AND, XOR, border, and blend operations.

The grayscale conversion oracle uses the intentional weights "0.3f / 0.5f / 0.2f" with the pinned implementation's rounding behavior.

### R3. Raw API

- Export the complete verified C ABI under the full-ABI package paths.
- Include allocator access, current memory views, and explicit pointer/ownership warnings.
- Treat raw declarations as a name-level compatibility aid, not a safe ownership model or semver promise.

### R4. Worker session client

- Keep image handles inside the worker and exchange IDs, operation data, and transferable output buffers.
- Support browser workers and Node worker_threads.
- Provide close poisoning, public terminate, in-flight failure handling, and deterministic cleanup.
- Verify output layouts for Vite, webpack, esbuild, and Node ESM fixtures.

### R5. Correctness and release quality

- Unit tests cover synchronous and worker APIs.
- Native-oracle comparisons cover image bytes and scalar tolerances.
- Mutation checks prove the oracle catches parameter mapping changes.
- Playwright compares browser and Node output bytes.
- Package review verifies the full-ABI files, declarations, license, README, and SHA-256 manifest.
- GitHub Release attaches the reviewed pnpm tarball built by CI.

### R6. Source-owned release variants

- Every valid JSON file directly under "variants/" is a private release member.
- "p0" is the unlocked development target; other targets are locked by their source-defined hostname policy.
- Locked browser initialization fails closed outside the allowed hostname or subdomains. Node and Node worker contexts remain available for builder verification.
- Canonical public identities derive from exact source revision, private membership, output contract, role, transport profile, and immutable seeds.
- Dispatch occurs only after source CI and reproducibility checks pass on "main".
- The public payload contains only contract version, exact source revision, immutable release ID, and the canonical public manifest.

## Acceptance criteria

- [x] Clean pinned CI builds are reproducible.
- [x] The curated Node chain preserves 1bpp semantics and produces PNG/RGBA output.
- [x] Browser worker output is byte-identical to the Node path.
- [x] Native-oracle and mutation checks pass.
- [x] Session close poisons further use and terminate leaves no worker process.
- [x] Declaration and export checks pass for curated and full-ABI surfaces.
- [x] Size-spike evidence supports the curated-default/full-ABI decision.
- [x] The pnpm tarball passes content review and is released only through GitHub Release.
- [x] Variant manifests, opaque identity resolution, lock behavior, dispatch schema, and retry behavior are covered by tests.

## Out of scope

- A hosted demo site.
- TIFF support in the curated API.
- Per-object remote disposal before real long-session pressure demonstrates a need.
- Registry publication.
