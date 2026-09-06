# Leptonica WebAssembly Design

## 1. Architecture

The system has five layers:

1. pinned native dependencies and deterministic build tooling;
2. Emscripten bindings and the full C-ABI artifact;
3. a curated synchronous TypeScript core;
4. a worker session client for browser and Node runtimes;
5. source-owned release-set tooling that dispatches opaque build targets.

The curated core is the product contract. The full ABI is an escape hatch. The worker layer is a mechanical remote form of the curated core. Release-set tooling does not change the API surface; it selects private compile-time policy and produces public immutable identities.

## 2. Repository structure

- "cpp/": Embind bindings and the native oracle.
- "src/core/": curated synchronous API and image lifetime management.
- "src/raw/": loose full-ABI loader and danger documentation.
- "src/worker/": shared protocol, browser client, Node adapter, and worker entry.
- "scripts/": build, export, smoke, type, package, and verification tooling.
- "build/": tracked release-set and lock-generation tooling with tests.
- "variants/": private source-owned release definitions.
- "vendor/versions.json": source and toolchain pins.
- "dist/": generated artifacts.
- "tmp/": disposable dependency, toolchain, and packaging state.

## 3. Build pipeline

"scripts/build.mjs" reads all dependency and toolchain inputs from "vendor/versions.json". It supports:

- the curated default build at optimization level O3;
- the full-ABI build under "dist/full-abi/";
- a private "--variant" selector resolved by source-owned tooling;
- reproducibility metadata in "build-report.json" and public provenance in "build-info.json".

Dependency completion markers include dependency commit, build flags, and toolchain identity. CI cache keys also include the build-script hash. Source downloads are atomic. Generated outputs are compared within one job and across an independent cold-build job.

The toolchain archive whitelist is checked only during cold installation, when retained archives exist. Cache-hit jobs do not retain the large download archive. Independent output comparison verifies the usable cached toolchain result.

An emsdk pin update follows this order: run the record-mode toolchain-hash workflow, review the complete archive set, update "vendor/versions.json", then run CI. Exact-set drift failures are intentional.

## 4. API layers

### 4.1 Curated layer

"Pix" owns one native image handle. It supports explicit disposal and "Symbol.dispose". Disposal or session termination poisons the object so subsequent operations fail consistently.

Operations are represented by the tagged union in "src/protocol.ts". The same schema drives synchronous chains, worker messages, and native-oracle input. Depth rules reject invalid combinations before native calls.

Binary operations retain and use a real second operand. Extraction copies bytes to JavaScript and frees the native transfer buffer. Query methods validate finite parameters and return scalar or structured data.

The grayscale anchor mirrors the pinned Leptonica implementation's intentional "0.3f / 0.5f / 0.2f" weights and rounding. This is a project contract, not a placeholder for a different coefficient standard.

### 4.2 Full-ABI layer

The full-ABI build exports the verified declaration-and-definition intersection plus allocator access. Its declaration file intentionally uses loose signatures. Consumers remain responsible for pointer width, allocation ownership, C strings, pointer-to-pointer output conventions, cross-instance safety, and function-specific destruction rules.

The package includes the full-ABI escape hatch. The promise that decoding is absent applies to the curated default artifact, not to the package as a whole.

## 5. Worker session model

The chain builder is the protocol seam. A client records operations and sends one run request. The worker owns the WebAssembly instance and an arena of source and retained result handles.

- Intermediate handles live only within one run call.
- Extraction returns bytes rather than ownership.
- "close()" releases the arena and poisons the session.
- "terminate()" stops the worker and rejects in-flight work consistently.
- Browser and Node clients share message shapes and error semantics.

Worker asset resolution has explicit package exports and supports a caller-provided wasm path. Bundler fixtures verify both generated code and the final wasm layout.

## 6. Type pipeline

Emscripten emits the low-level declaration shape. Repository tooling produces distributable JavaScript and declaration files under "dist/types/", rewrites internal specifiers, and supplies the ambient glue shape required by strict consumers.

CI verifies:

- curated methods against the hand-owned interface;
- full-ABI declaration names against actual wasm exports;
- strict downstream compilation with "skipLibCheck: false";
- package shape with a package-analysis tool;
- a real consumer runtime chain.

## 7. Test strategy

The test system avoids self-confirming implementations through three independent anchors:

1. hard-coded discriminating values for small invariants;
2. a native Leptonica oracle compiled from the same exact pins;
3. mutation checks that deliberately alter parameter mappings and must fail.

CI covers unit tests, synchronous and worker behavior, curated and full-ABI smoke tests, export checks, native-oracle comparisons, bundler fixtures, Playwright browser/Node byte comparison, secret scanning, and cross-job reproducibility.

## 8. Release variants and public contract

Each private variant contains exactly "variant", "domain", "product_lock", "description", and "target_seed". Validation is fail-closed. The unlocked target is exactly "p0". Locked browser startup checks the configured hostname before registering the Embind surface.

"build/release_set.py" reads variants from the exact Git tree identified by "source_revision". It canonicalizes public JSON, derives opaque target and release IDs with independent domain separators, verifies requested identities, and invokes the private build selector internally.

The public manifest includes only schema version, release ID, source revision, opaque target IDs, build roles, required output names, and transport profile. The dispatch payload adds no private routing or variant fields.

The source repository owns the two dispatch configuration names documented in "docs/release-set-contract.md". The builder repository owns its complete environment, secret inventory, transport implementation, candidate lifecycle, and provisioning documentation.

Transport disconnections, HTTP 429, and transient HTTP 5xx responses retry with bounded exponential backoff until workflow timeout. Other HTTP failures stop immediately with diagnostics.

## 9. Release

Tag-triggered CI performs a cold verified build, tests both artifact modes, generates the SHA-256 manifest, reviews the pnpm package contents, and creates a GitHub Release containing the tarball. Registry publication is absent by design.

Branch protection on "main" is the trust root for reviewed toolchain whitelist and release-workflow changes.

## 10. Compatibility and rollback

- Curated API changes follow semver and require consumer tests.
- Full-ABI behavior follows pinned native sources and carries no safe-wrapper promise.
- Worker exports can be removed without changing the synchronous core.
- Individual curated operators can be reverted independently.
- Variant schema or identity changes require a new schema and identity version.
