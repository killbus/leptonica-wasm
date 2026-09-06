# M1 Handover

## State

M1 completed the curated-versus-full-ABI size spike and passed its review gate. The curated artifact is the default and the full ABI is the compatibility escape hatch.

## Evidence

- CI run 33767637278 passed after the build, smoke, and export assertions were aligned with optimized Emscripten behavior.
- Curated wasm: approximately 406 KB raw and 105 KB gzip.
- Full ABI: approximately 2.59 MB raw and 855 KB gzip with 2,745 verified functions.
- Repeated clean builds produced identical hashes.
- The curated artifact contains the required PNG/JPEG write behavior and no curated decode entry surface.

## Decisions carried forward

- Use "em++" for the final C++/Embind link.
- Include the internal complete Pix definition after the public header where Embind needs RTTI and destruction.
- Keep the curated build at O3. The full ABI uses the optimization posture required to preserve callable export names.
- Treat encoder behavior and library-level symbol evidence as the correctness signal; optimized functions may be inlined and disappear as standalone symbol-map entries.
- Interpret optional-codec stubs separately from real decoder-library symbols.
- Keep all heavy builds in CI and all fetched sources under "tmp/".

## Next milestone

M2 formalizes cache invalidation, export verification, cross-job reproducibility, archive verification, and supply-chain automation.
