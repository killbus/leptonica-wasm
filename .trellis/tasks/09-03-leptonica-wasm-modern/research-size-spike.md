# M1 Size Spike

## Goal

Measure a minimal curated Leptonica WebAssembly artifact against a verified full C-ABI build, test deterministic output, and determine whether the curated artifact can exclude decoder entry paths while retaining PNG/JPEG encoding.

## Method

- Build exact pinned zlib, libpng, libjpeg-turbo, and Leptonica sources in GitHub CI.
- Link the curated Embind surface at O3.
- Generate the full declaration-and-definition export set for the full ABI.
- Run two clean curated builds and compare hashes.
- Run functional smoke tests for RGBA input, grayscale conversion, PNG, JPEG, and RGBA extraction.
- Inspect the optimized artifact for curated decode symbols and codec-library read paths.

## Key implementation findings

- Embind class registration requires the complete Pix type, not only the public forward declaration.
- The final link uses "em++" so C++ RTTI, allocation, and Embind symbols resolve.
- Optimizers may inline a wrapper's only native call, so absence of one standalone encoder symbol is not proof that encoding is absent.
- Export-name minification conflicts with a directly callable full ABI at O3. The full-ABI build uses the optimization posture that preserves names.
- Optional-codec compatibility stubs may retain high-level function names even when the real decoder library symbols are absent.

## Results

CI run 33767637278 passed all build, determinism, export, and smoke checks.

| Artifact | Raw wasm | Gzip wasm | Verified callable surface |
| --- | ---: | ---: | ---: |
| Curated default | about 406 KB | about 105 KB | Embind contract |
| Full ABI | about 2.59 MB | about 855 KB | 2,745 functions |

The two curated builds produced identical SHA-256 values. Cold build time was approximately 93.8 seconds in the measured runner. The curated artifact retained required PNG/JPEG encoding behavior and had no curated "pixRead" entry surface or real decoder-library path.

## Decision

Ship the curated artifact by default and the full ABI as an explicit escape hatch. The approximately 750 KB gzip increase is material and the full export surface is unnecessary for normal consumers.

The exact size ratio is an observation, not a permanent threshold. The durable decision is structural: curated API and linker reachability are the default; broad native compatibility is opt-in.

## Follow-up

M2 formalized export checks, same-optimization comparison, cache invalidation, independent cold reproducibility, and toolchain archive verification. M4 replaced the spike's limited functional anchors with the native-oracle suite.
