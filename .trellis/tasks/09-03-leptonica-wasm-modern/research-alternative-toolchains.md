# Alternative WebAssembly Toolchain Patterns

## Scope

This note compares integration patterns that were considered before selecting the repository's Emscripten architecture. It intentionally records reusable mechanisms rather than identities or implementation details from unrelated repositories.

## Patterns considered

### Native C/C++ plus Emscripten

- Compiles the pinned C library and codecs directly.
- Supports Embind for a curated object API and direct exports for a C-ABI escape hatch.
- Reuses the native build system and keeps one source pin set for native and wasm oracle builds.
- Fits browser and Node ESM output without an additional language runtime.

### Language-wrapper plus prebuilt native archive

- Wraps a native library through a language-specific FFI package.
- Often separates archive production from package consumption.
- Can provide rich generated types, but adds a second toolchain, ABI layer, and package graph.
- Requires explicit handling for runtime shims, archive provenance, target triples, and cross-repository version coordination.

### Build-only artifact service

- Produces binaries without owning a product API.
- Keeps compilation concerns isolated but leaves lifetime, packaging, runtime loading, and consumer compatibility to downstream code.

## Decision

Use direct Emscripten compilation with a thin TypeScript layer. This keeps the native source pins, curated API, full-ABI escape hatch, worker model, tests, and package contract in one repository.

The useful mechanisms retained from the comparison are:

- exact source and toolchain pins;
- immutable archive hashes;
- independent producer/consumer contract tests;
- explicit public/private schema boundaries;
- browser and Node end-to-end verification;
- GitHub-hosted release artifacts with content manifests.

## Boundary rule

Durable project documentation describes this repository's contracts. External examples may inform research, but their names, private configuration, and unrelated product structure are not part of the product or builder contract.
