# Baseline and contract evidence

Inspected on 2026-09-06. This is planning evidence, not runtime verification.

## Provenance and authority

- Handoff repository: pdfhow, branch
  `research/document-whitening-leptonica-handoff`, commit
  `aa4219446978c817216dd1afe664d1b7a301b416`,
  `docs/dev/document-whitening-leptonica-handoff.md`. Read with `git show`;
  the current pdfhow worktree is not the handoff source of truth.
- Receiving baseline: leptonica-wasm
  `00594e6bd7418f7b571307e9da2ebb065beb12c1`, from fetched `origin/main`.
  The isolated worktree is on `feat/document-cleaning-pipeline`. Neither
  original dirty worktree was switched, cleaned, staged, or edited.
- The handoff's observed leptonica-wasm SHA `7fece461...` is historical,
  not the implementation baseline. Re-fetch and review upstream changes
  before activation and again before integration.
- The user subsequently approved implementation. During implementation the
  user identified a first-principles boundary error: leptonica-wasm is not a
  pdfhow-specific service. The revised design therefore keeps product policy
  outside this repository.

## Current-source findings

Severity describes the integration impact, not a claim of an observed crash.

| Evidence | Finding at the receiving baseline | Requirement |
| --- | --- | --- |
| E1, `src/core/types.ts:139`, `src/core/types.ts:228`, `src/core/types.ts:247`, `src/core/chain.ts:243` | Pix disposal, instance close, adoption, poisoning, and chain intermediate cleanup already exist. Extend them. | R1 |
| E2, `src/core/types.ts:89`, `src/protocol.ts:174`, `cpp/bindings.cpp:181` | P0: no toMask or background/area/color-mask curated operators. Sauvola calls the untiled `pixSauvolaBinarize` at line 184, despite the tiled comment in the protocol. A high-level product pipeline is deliberately not a binding requirement. | R2, R3 |
| E3, `cpp/bindings.cpp:303` | P0: connComp requests 8-connectivity and returns boxes, not a four-connected filtered PIX. | R2 |
| E4, `cpp/bindings.cpp:65`, `cpp/bindings.cpp:80`, `cpp/bindings.cpp:184` | P0 risk: JS allocation/copy can throw before native buffer cleanup; input copying also crosses JS while a PIX is owned in C++. Sauvola does not explicitly destroy a partially assigned output on error. No injected-failure runtime leak has been measured in this task. | R1, R7 |
| E5, `src/worker/worker.ts:10`, `src/worker/worker.ts:98`, `tests/node/worker.test.ts:121` | The worker arena retains externally visible handles until close. RemotePix deliberately has no dispose method. New generic operations and mask extraction must preserve this contract. | R4 |
| E6, `package.json:25`, `scripts/gen-types.mjs:220`, `.github/workflows/release.yml:92`, `.github/workflows/release.yml:98` | P0: exports need generated dist; no prepare/prepack hook exists. Release hashes precede the full-ABI build, and release does not explicitly run gen-types, which also creates worker wrappers. | R5, R6 |
| E7, `tests/consumer/package.json:7`, `tests/consumer/package.json:10`, `.github/workflows/ci.yml:288` | P0: the consumer installs `file:../..`; its declaration-tool entrypoint filter is only `.`. This does not prove Git source, actual tarball, or all-export consumption. | R5, R6 |
| E8, `tests/node/core.test.ts:224`, `tests/node/worker.test.ts:105`, `tests/node/raw.test.ts:13` | P1: failure tests check usability/results, not a native-allocation delta. Several runtime suites skip without dist; such a local run cannot prove memory safety or WASM behavior. | R7 |
| E9, `scripts/build.mjs:82`, `scripts/build.mjs:183`, `scripts/build.mjs:195` | libjpeg SIMD is disabled, default/full-ABI optimization differs, and WASM memory growth is enabled. No demonstrated wasm SIMD acceleration or shrinking-heap guarantee exists. | R8 |
| E10, `docs/release-set-contract.md:3`, `.trellis/spec/build-ci/execution-discipline.md:133` | Release membership is source-owned; public builder payloads remain opaque. GitHub Release is the publication channel. Neither npm publication nor builder-repository changes belong to this task. | R9 |

The receiving package no longer has even the `prepublishOnly` hook mentioned
in the older handoff. Preserve this distinction when describing current state.

## Leptonica 1.87.0 primary evidence

Pinned by `vendor/versions.json` to
`13275a278eb55b5746e33f95fbf5a2c8f604b3ab`. Do not use moving master as evidence.
The following URLs identify the exact source revision.

- [adaptmap.c, lines 190-239](https://github.com/DanBloomberg/leptonica/blob/13275a278eb55b5746e33f95fbf5a2c8f604b3ab/src/adaptmap.c#L190):
  clean-background input is 8/32 bpp; recommended gamma/black/white are
  1.0/70/190. White must be at most 200; upstream silently resets larger
  values. The wrapper will validate instead of silently changing them.
- [binarize.c, lines 449-560](https://github.com/DanBloomberg/leptonica/blob/13275a278eb55b5746e33f95fbf5a2c8f604b3ab/src/binarize.c#L449):
  tiled Sauvola needs non-colormapped 8 bpp, half-window at least 2,
  dimensions at least `2 * whsize + 3`, and nonnegative factor. Tiles
  must be at least `whsize + 2` per axis. Unrequested outputs may be null.
  A 1-by-1 tile grid deliberately delegates to untiled Sauvola. Tiling is
  not proof of parallel execution in this WASM build.
- That tiled function assigns output PIX pointers before processing tiles
  and does not check every internal allocation or operation status. Outer
  output guards alone do not establish internal OOM safety. Native failure
  tests must cover this distinction; a needed safety adapter must retain
  upstream algorithm semantics and be oracle-tested.
- [pixafunc1.c, lines 807-881](https://github.com/DanBloomberg/leptonica/blob/13275a278eb55b5746e33f95fbf5a2c8f604b3ab/src/pixafunc1.c#L807)
  and [numafunc1.c, lines 1168-1222](https://github.com/DanBloomberg/leptonica/blob/13275a278eb55b5746e33f95fbf5a2c8f604b3ab/src/numafunc1.c#L1168):
  `pixSelectByArea(binary, 3, 4, L_SELECT_IF_GT, ...)` retains components
  with area strictly greater than 3, using four-connectivity.
- [colorcontent.c, lines 655-734](https://github.com/DanBloomberg/leptonica/blob/13275a278eb55b5746e33f95fbf5a2c8f604b3ab/src/colorcontent.c#L655):
  `pixMaskOverColorPixels` returns a 1 bpp mask. A color pixel has
  `max(R,G,B)-min(R,G,B) >= threshdiff`. `mindist=1` performs no erosion;
  larger distances erode by a `2 * (mindist - 1) + 1` square. This is a
  trade-off between edge-chroma rejection and faded/thin stamp retention.
- [pixconv.c, lines 1992-2050](https://github.com/DanBloomberg/leptonica/blob/13275a278eb55b5746e33f95fbf5a2c8f604b3ab/src/pixconv.c#L1992):
  `pixConvert1To32` supports an explicit black/white expansion.
- [skew.c, lines 192-355](https://github.com/DanBloomberg/leptonica/blob/13275a278eb55b5746e33f95fbf5a2c8f604b3ab/src/skew.c#L192):
  deskew may return a clone. Estimation failure and insufficient confidence
  need distinct handling from allocation failure. The same applied angle
  must transform color source, text layer, and mask.
- Handoff dewarp evidence establishes large full-resolution disparity
  structures, not an official 16 bytes/pixel constant. No dewarp memory
  measurement is claimed here.

## Curated decoder-reachability evidence

Inspected on 2026-09-07 against the same pinned Leptonica commit and the
default artifacts from CI run `34089310296`.

- The failed default symbol map contains `pixMorphSequence` together with
  `jpeg_read_header`, `jpeg_CreateDecompress`, `jpeg_stdio_src`, and
  `jpeg_resync_to_restart`; the earlier successful main artifact contains none
  of those decoder symbols.
- [adaptmap.c, lines 876-930](https://github.com/DanBloomberg/leptonica/blob/13275a278eb55b5746e33f95fbf5a2c8f604b3ab/src/adaptmap.c#L876)
  shows `pixGetBackgroundGrayMap()` calling
  `pixMorphSequence(pixb, "d7.1 + d1.7", 0)`.
- [morphseq.c, lines 137-235](https://github.com/DanBloomberg/leptonica/blob/13275a278eb55b5746e33f95fbf5a2c8f604b3ab/src/morphseq.c#L137)
  retains `pixDisplay()` in the compiled function body even though this call
  site passes `dispsep = 0`; ordinary static linking cannot assume that runtime
  argument throughout a separately compiled archive member.
- [environ.h, lines 396-476](https://github.com/DanBloomberg/leptonica/blob/13275a278eb55b5746e33f95fbf5a2c8f604b3ab/src/environ.h#L396)
  defines `NO_CONSOLE_IO` as message-severity control. It does not remove the
  `pixDisplay()` branch.
- [writefile.c, lines 855-923](https://github.com/DanBloomberg/leptonica/blob/13275a278eb55b5746e33f95fbf5a2c8f604b3ab/src/writefile.c#L855)
  places `pixDisplay()` and generic image-writing behavior in the desktop I/O
  translation unit. A curated-only definition of `pixDisplay()` can satisfy
  the debug edge before archive extraction; the full-ABI build must omit that
  definition so its upstream ABI and behavior remain intact.

CI run `34092410049` proved that a second strong `pixDisplay()` definition in
`bindings.o` is not a valid isolation mechanism: `wasm-ld` reported the
definition again in `libleptonica.a(writefile.c.o)` and rejected the link. The
revised hypothesis uses the linker's `--wrap=pixDisplay` mechanism with a
separately named `__wrap_pixDisplay()` implementation only in curated builds.
This avoids the duplicate-definition failure and should satisfy the debug edge
without archive extraction. If another required symbol still extracts
`writefile.c.o`, the existing decoder-symbol gate must detect the retained
graph; the wrapper is not treated as proof by itself. Full-ABI builds omit both
the compile-time wrapper and linker option.

This is a source-and-artifact causal hypothesis, not final proof. A clean
target-WASM link must still pass the existing decoder-symbol gate.

## Fixed-commit pnpm installation research

Official sources inspected on 2026-09-06:

- [pnpm 10.x package sources](https://pnpm.io/10.x/package-sources): Git
  commit hashes and `github:` shorthand are supported; a local directory
  dependency is a different installation path.
- [pnpm 10.x add](https://pnpm.io/10.x/cli/add): explicit build-script
  approval is separate from choosing the package source.
- [pnpm v10.34.5 Git fetcher](https://github.com/pnpm/pnpm/blob/v10.34.5/fetching/git-fetcher/src/index.ts):
  validates a 40-character commit, checks out and verifies it, prepares
  the package, then removes `.git` and applies packlist.
- [pnpm v10.34.5 prepare-package](https://github.com/pnpm/pnpm/blob/v10.34.5/exec/prepare-package/src/index.ts):
  build preparation requires `allowBuild` for the resolved Git dependency
  identity; `ignoreScripts` skips preparation. It installs source
  dependencies using the detected package manager and handles preparation
  lifecycle scripts. It explicitly does not run `prepublishOnly`.

Design implication: the Git gate must approve the exact resolved dependency
identity using the pinned pnpm policy, allow its preparation lifecycle, and
prove it generates its own dist. Do not globally enable dependency scripts,
reuse the working-tree dist, or silently substitute a tarball URL.

The proposed source route builds with the already provisioned pinned CI
toolchain; the consumer directory and pnpm store start clean. It is a
documented build-from-source route, not a promise of compiler-free source
installation. Ordinary application consumption uses the independently
tested prebuilt GitHub Release tarball. A compiler-free Git route would
need a separate artifact/provenance design and must not be claimed as done.

No GitHub Actions were added or changed during planning. Before changing
any `uses:` entry, implementation must research its official documentation,
latest applicable release/date, inputs/permissions, and immutable commit.

## Benchmark sources and evidence limits

The handoff commit's
`app/lib/pdf-worker/operations/page/document-whitening-scanner-clean.ts`
defines window 41, Sauvola k=0.24/R=128, background window 121, and removal
of four-connected components of area at most 3. JS background estimation
and boundary handling are not identical to Leptonica; compare quality, not
assumed byte parity between those different algorithms.

Use the handoff's algorithms, scanner-clean, integral helpers, and benchmark
harness as pinned read-only JS references. Do not include unrelated pdfhow
changes or copy customer scan assets into this repository.

The conflicting historical claims are not a performance baseline:
`380 ms / 8.5 MP = 44.7 ms/MP`, not 91 ms/MP. Re-measure identical decoded
inputs on the same device/browser and distinguish startup from steady work.

No builds, native/WASM runtime tests, package installs, real-scan runs,
benchmark scores, or production-readiness claims were produced in planning.
