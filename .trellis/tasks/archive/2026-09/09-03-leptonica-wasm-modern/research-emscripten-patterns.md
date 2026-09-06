# Emscripten Integration Patterns

## Build model

- Build zlib, libpng, libjpeg-turbo, and Leptonica as pinned static libraries with Emscripten CMake and Ninja.
- Use "em++" for the final link because Embind and RTTI require the C++ runtime.
- Include the complete internal Pix definition only where Embind type registration and destruction require it.
- Keep fetched sources and toolchains under "tmp/" and generated artifacts under "dist/".

## Runtime and API model

- Use Embind for the curated object surface.
- Use explicit exported functions for the full C ABI.
- Keep pixel transfer at the boundary and preserve native handles through operation chains.
- Provide a thin TypeScript ownership layer instead of mirroring the complete native API as safe wrappers.
- Use one wasm instance per worker session and transfer large output buffers.

## Packaging model

- Publish ESM JavaScript, wasm, declarations, and worker entry points through explicit package exports.
- Keep wasm location overrideable for bundler and CDN layouts.
- Validate Vite, webpack, esbuild, Node ESM, browser workers, and Node worker_threads.
- Generate the package tarball with pnpm and attach it only to GitHub Release.

## CI model

- Resolve every dependency and tool from a tracked exact pin.
- Verify cold toolchain archives against an exact whitelist.
- Compare repeated outputs within a job and against an independent cold-build job.
- Verify declarations, exports, package contents, browser behavior, and native-oracle parity.
- Pin workflow actions to immutable commits after reading official release documentation.

## Adopted constraints

- No local heavy compilation.
- No floating toolchain or action versions.
- No pthread requirement.
- No registry publication.
- Curated default artifact plus explicit full-ABI escape hatch.
