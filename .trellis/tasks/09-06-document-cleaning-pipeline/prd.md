# Document-imaging bindings and adoption evidence

## Goal

Extend leptonica-wasm with safe, general-purpose curated bindings needed by
document-imaging consumers, then prove package consumption, lifecycle safety,
and measurable behavior. pdfhow is one consumer and benchmark target; it does
not define the library's public workflow or defaults.

The starting assessment remains conditional go. Production adoption requires
the tests, package gates, and measurements below.

## Architectural boundary

The repository has three distinct responsibility layers:

1. Leptonica owns native image-processing semantics and the full ABI.
2. leptonica-wasm owns faithful JavaScript/WASM bindings, validation,
   ownership, worker transport, and stable primitive contracts.
3. Consumers such as pdfhow own operation order, parameter profiles, output
   policy, color-retention decisions, deskew policy, and product fallbacks.

Consequently, this task does not add a documentClean convenience API or encode
a pdfhow-specific pipeline in the main or worker entry points. A consumer may
compose the curated operations through the existing chain API or use the
raw/full ABI when it accepts native ownership responsibility.

## Requirements

### R1 - Safe ownership and copy boundaries (P0)

Every new native result has one owner. Partial PIX** results and native byte
buffers are released on success, error, and JavaScript allocation/copy
failure. Borrowed inputs remain alive. Existing dispose, close, poisoning, and
cross-instance guards remain authoritative. A fatal WASM trap retires its
instance or worker rather than masquerading as a recoverable operation error.

### R2 - General curated primitives (P0)

Add faithful wrappers for:

- background normalization through cleanBackgroundToWhite;
- tiled Sauvola through sauvolaTiled;
- area-based connected-component selection through selectByArea;
- color-pixel mask generation through maskOverColorPixels; and
- compact 1 bpp extraction through Pix.toMask() and RemotePix.toMask().

Parameters that choose processing policy are explicit. In particular, the
binding does not silently choose four-connectivity, area 3, a Sauvola profile,
or color thresholds for consumers. Preserve existing sauvola() numerics; fix
only its misleading comment and incomplete output cleanup.

### R3 - Explicit primitive contracts (P0)

Validate depth, colormap restrictions, native numeric domains, overflow-safe
limits, tile geometry, and native failure at the binding boundary. Define
selectByArea with explicit `lt`, `gt`, `lte`, or `gte` relation and explicit 4
or 8 connectivity; the binding must not choose a consumer's area policy.

toMask() returns JS-owned, row-major, MSB-first bytes with strideBytes equal
to ceil(width / 8), foreground bit 1, zeroed row padding, and no native word
padding. Returned bytes survive Pix disposal, heap growth, and worker transfer.

### R4 - Main/worker parity for generic operations (P1)

The shared Op schema, ChainBuilder, core executor, browser worker, and Node
worker expose the same primitive semantics. Existing worker arena ownership
and no-per-RemotePix-dispose behavior remain unchanged. Mask extraction is a
generic terminal operation; no product pipeline, page profile, or pipeline-
specific cancellation protocol is introduced here.

### R5 - Complete distributable and exports (P0)

Generate and test every declared main/raw/worker/worker-node/worker-entry,
curated/full-ABI JavaScript, WASM, and declaration entry. The package includes
LICENSE, README, version pins, provenance, and final hashes. Hash only after
all package generators have completed.

### R6 - Two independent clean consumers (P0)

Gate both the actual release tarball and a pnpm GitHub dependency at a
reachable fixed 40-character commit. Each gate uses a fresh consumer and store
and verifies the complete export set. A local file dependency cannot satisfy
either gate.

### R7 - Resource and failure regression gates (P1)

Exercise repeated primitive chains, extraction, invalid inputs, partial native
outputs, worker close/terminate, and at least 100 measured sequential pages.
Verify native live-resource deltas separately from WASM capacity and process
RSS. A skipped runtime suite is not passing evidence.

### R8 - Consumer-owned comparison protocol (P1)

Use an external benchmark adapter to compose JS and WASM variants over the
same authorized scans. Parameters and operation order belong to the benchmark
profile, not the leptonica-wasm API. Measure quality/OCR proxy, cold/first/
steady timing, memory, output costs, and package size. Report a no-go if the
evidence warrants it.

### R9 - Repository and delivery discipline (P0)

Keep heavy builds in CI, preserve pnpm and pinned toolchains, and publish only
through the existing GitHub Release process. Integrate through an ordinary
reviewed PR after synchronizing with origin/main. Do not modify main directly,
force-push, or mutate unrelated worktrees.

## Acceptance criteria

- [ ] AC1: Oracle and target-WASM tests cover every new primitive, including
  tiled output, area 3/4 boundaries, diagonal connectivity, invalid depths,
  and mask widths 1/7/8/9/31/32/33.
- [ ] AC2: Main, Node worker, and browser worker produce identical primitive
  and mask results; existing lifecycle behavior remains intact.
- [ ] AC3: Native resource counts return to baseline after success and every
  recoverable failure path; repeated-page memory stays within documented
  budgets.
- [ ] AC4: Tarball and fixed-commit Git consumers independently validate all
  exports, declarations, assets, hashes, and runtime loader paths.
- [ ] AC5: A reproducible external benchmark records inputs, profile,
  versions, quality, timing, memory, and size without promoting that profile
  into the library contract.
- [ ] AC6: Evidence corresponds to the final reviewed PR head and ordinary PR
  integration; no unauthorized publication or unrelated mutation occurred.

## Out of scope

- A documentClean API or any fixed document-cleaning recipe in leptonica-wasm.
- pdfhow production integration, product defaults, or fallback behavior.
- A generic pipeline DSL beyond the existing explicit operation chain.
- Dewarp in this iteration.
- npm publication, toolchain upgrades, builder-repository changes, and
  customer-document upload.

Historical timing claims are not a baseline: 380 ms / 8.5 MP is approximately
44.7 ms/MP, not 91 ms/MP. Leptonica source also does not establish a universal
16-bytes-per-pixel dewarp cost; any later claim must be measured in the target
WASM build.
