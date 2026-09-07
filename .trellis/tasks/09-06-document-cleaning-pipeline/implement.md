# Implementation and review plan

Status: implementation in progress on the isolated feature worktree. The
scope was corrected on 2026-09-06: leptonica-wasm supplies general bindings;
consumer-specific document-cleaning policy remains outside this repository.

## Operating constraints

- Work only in /home/agent/Src/leptonica-document-cleaning-pipeline.
- Preserve the original dirty pdfhow and leptonica-wasm worktrees.
- Use pnpm and pinned toolchains. Heavy native/WASM builds run in CI.
- Do not modify main directly, force-push, publish, or upload scan data.
- Treat stream disconnects, HTTP 429, and transient 5xx responses as retryable.
  Back off, honor Retry-After, inspect remote state before retrying a
  non-idempotent operation, and keep monitoring until terminal state.
- Dispatched review agents use the user-approved route. Record the effective
  routed model when the runtime exposes it; do not infer it from an omitted
  override or replace a requested route silently.
- Every dispatched agent must make create_goal its first action. The
  agent-owned goal must include its exact assignment and the retry policy.
- Because the main thread has an active goal, dispatch with isolated context
  (`fork_context: false`) and pass task context explicitly unless the platform
  can prove goal-state isolation. An inherited parent goal is not sufficient.
- Until goal creation succeeds, the instance is not started. If goal creation
  itself fails or reports `GOAL_MISSING`, the agent must stop without task
  work; do not wait for, resume, or send task input to it. Close that instance
  and create a replacement. If an already active goal is
  interrupted by a stream disconnect, HTTP 429, or transient 5xx, preserve the
  same agent and goal: resume it, inspect status, send recovery input when
  useful, and continue waiting with backoff rather than replacing it.
- Actively monitor dispatched work: confirm goal activation, check during the
  early failure window and at planned checkpoints, inspect unclear status,
  interact for recovery or follow-up when useful, and verify a terminal event.
  Do not use passive waiting as the only response to a running or recovering
  agent.
DBS review evidence on 2026-09-07:

- Nancy Leveson, Karl Popper, and Barbara Liskov completed two independent
  review rounds. Each instance performed agent-owned `create_goal` as its
  first action, included the disconnect/429/transient-5xx recovery policy, and
  reached an explicit completed goal state.
- Leveson's first-round review rejected an earlier broad patch candidate whose
  failure behavior was not justified at the general Leptonica boundary. The
  accepted canonical patch was reduced to recoverable allocation paths in
  eight foundational containers; its SHA-256 is
  `2e2070fbc3180114e5300d84e09272d45c283ef657e62cd69a69884db0ae5fd7`.
- Popper's falsification review showed that a declarative source marker did
  not prove source contents. Liskov's contract review required both build
  callers to share the same source identity semantics without introducing a
  pdfhow-specific policy API. The resulting implementation binds upstream and
  patched tree digests, patch identity, provenance, and cache paths.
- The second round supplied concrete counterexamples for marker symlink
  write-through, missing transitive cache identity, mutable installed static
  libraries, and replacement of a supposedly immutable source directory. The
  implementation now rejects non-regular markers, uses identity-addressed
  source directories, hashes the complete install tree, and rebuilds the whole
  dependency set when any source/configuration identity changes.
- Later cross-audits found five additional supply-chain failure classes: an
  install-tree digest that ignored a marker-shaped file, incomplete toolchain
  identity, concurrent dependency-cache writers and lock-owner replacement,
  native `CMAKE_TOOLCHAIN_FILE` injection, and two callers sharing one fixed
  download `.part`. The implementation now hashes every installed file, binds
  the complete pinned/observed toolchain and environment, serializes each
  identity-addressed build with an owner token, rejects the native toolchain
  override, and gives every download a private PID/UUID candidate.
- Both build callers now use one `prepareSourceTreeFromArchive` contract. It
  publishes a candidate with an atomic no-clobber hard link only after the
  extracted and patched source tree passes its complete digest checks, adopts
  a separately verified concurrent winner, and removes losing candidates and
  staging trees. Failing tests cover pre-verification rejection, damaged-cache
  fail-closed behavior, a barrier-synchronized two-process publish race, and
  source-tree rename contention. These source-only reviews do not replace
  target-WASM, Chromium, native-oracle, multipage, or allocation-sweep
  execution evidence.

## M0: Correct the contract boundary (R1-R9)

- [x] Identify that the original documentClean proposal encoded pdfhow policy
  in a general-purpose binding package.
- [x] Separate native capability, curated safety bindings, and consumer-owned
  orchestration in the PRD and design.
- [x] Remove the unfinished documentClean API, worker request, default profile,
  and document-specific native helpers from the implementation.
- [x] Require policy-bearing arguments explicitly on new curated operations.
- [x] Validate the revised Trellis task and record the boundary review.

Review gate: no fixed pdfhow operation order, threshold profile, color policy,
deskew policy, or output choice remains in a leptonica-wasm public contract.

## M1: Safe curated primitives (R1-R3, R7)

Primary targets: cpp/bindings.cpp, cpp/oracle.c, src/protocol.ts,
src/core/types.ts, src/core/chain.ts, curated declarations, and focused tests.

- [x] Add background normalization, tiled Sauvola, explicit-connectivity area
  selection, color-pixel mask, and compact-mask extraction bindings.
- [x] Extend the shared operation/depth schema and ChainBuilder with explicit
  parameters and no pdfhow-specific defaults.
- [x] Preserve existing sauvola() numerics and clean a partially assigned
  output when the native call reports failure.
- [x] Harden RGBA input and byte extraction copy boundaries so native storage
  is released when JavaScript allocation/copy fails.
- [ ] Add native-oracle coverage for each primitive and exact semantics.
- [ ] Add target-WASM tests for invalid depths/ranges, multi-tile output,
  area 3/4, diagonal connectivity, and color-mask thresholds.
- [ ] Test mask widths 1/7/8/9/31/32/33, row padding, polarity, disposal, and
  heap growth.
- [x] Add reproducible partial-output and JavaScript-copy fault injection.
- [ ] Confirm the curated build does not pull forbidden decode symbols or
  violate size/export allowlists.

Review gate: old goldens and new oracle/WASM tests pass, all recoverable paths
return native live-resource counts to baseline, and the exact public surface
matches design section 2.

## M2: Worker parity (R4, R7)

Primary targets: src/worker/protocol.ts, session.ts, worker.ts, Node tests, and
browser E2E tests.

- [x] Add mask as a generic extraction format and expose RemotePix.toMask().
- [x] Reuse the existing Op wire format for all new curated transformations.
- [x] Preserve arena ownership and public close/terminate behavior; make fatal
  teardown client-owned so a DOM Worker cannot self-close ahead of its final
  terminal message.
- [x] Add a deterministic terminal-state unit test and a CI-wired real Chromium
  test using the target instrumented WASM trap, concurrent pending requests, a
  production browser-adapter teardown assertion, a separate post-fatal
  no-reentry probe, and a fresh-session recovery check.
- [x] Route browser and Node initialization failures through the idempotent
  session-retirement gate, with a regression test proving an `init` fatal
  response terminates the platform Worker exactly once.
- [ ] Test direct/Node-worker/browser-worker parity for each new operation and
  mask packing.
- [ ] Test malformed operations, extraction failures, worker death, close and
  terminate races, and calls through poisoned proxies.
- [ ] Verify repeated worker chains and extraction do not retain unexpected
  native resources.

Review gate: all three execution surfaces agree and existing worker lifecycle
tests remain green. No pipeline-specific request or cancellation semantics are
introduced.

## M3: Package generation and independent consumers (R5, R6, R9)

- [ ] Unify package preparation so curated/full-ABI builds and generated
  declarations/worker files complete before final hash generation.
- [ ] Build one recursive export, asset, declaration, and runtime checker for
  both consumer gates.
- [ ] Gate the exact release-candidate tarball in a fresh consumer/store with
  scripts disabled and no compiler requirement.
- [ ] Gate pnpm add from a reachable fixed GitHub commit in a second fresh
  consumer/store, with explicit dependency-script approval and pinned tools.
- [ ] Verify installed resolution, realpath, lockfile, manifest, bytes, and
  source/asset identity; repeat with a fresh store.
- [ ] Cover NodeNext, browser bundlers, browser worker, worker-node, raw,
  curated, and full-ABI exports with strict declaration checking.
- [ ] Preserve release-set privacy, reproducibility checks, and GitHub
  Release-only publication.

Review gate: both independent consumers pass against the same reviewed source
revision and the packed bytes are the candidate later attached to a release.

## M4: Resource regression suite (R1, R4, R7)

- [x] Add CI-only native allocation counters and deterministic fault points
  without creating supported production exports.
- [x] Cover each new native stage before/after allocation, partial PIX**
  outputs, extraction allocation/copy failures, and chain cleanup.
- [ ] Run 20 warm-up plus at least 100 measured pages for fixed and mixed
  workloads, including repeated worker sessions.
- [ ] Enforce zero retained owned native resources after recoverable failures
  and document separate WASM-capacity/JS/RSS budgets.
- [ ] Cross-check instrumented results against a production build and save
  per-page diagnostics when a gate fails.
- [ ] Fail mandatory CI when required dist, fixtures, instrumentation, or
  runtime prerequisites are absent; a skip is not a pass.

Review gate: deterministic cleanup and bounded multipage retention pass under
the target WASM build.

Current evidence boundary (2026-09-07): the isolated instrumented build mode,
allocator hooks, named faults, runtime suite, mandatory CI invocation, and
production-artifact rejection checks are implemented. Fatal-trap retirement is
implemented at the curated native boundary, worker arena, and client session:
the heap is poisoned, native destructors are abandoned after a trap, fatal
responses terminate pending work, cross-realm RuntimeError detection is covered,
and native/worker handles plus wrapper construction are hidden from the public
runtime surface. Static and simulated-runtime coverage also verifies that
Leptonica.close() continues destroying remaining Pix values after an ordinary
destructor error before rethrowing the first failure.

The 2026-09-07 lightweight run passed typecheck, 89 tests, release-contract
tests, task validation, and `git diff --check`. Five artifact-dependent files
containing 58 tests skipped because `dist`/`dist-instrumented` are absent; those
tests are unverified, not passing. The generated declaration script also cannot
complete without the CI-produced full-ABI module, although a declaration-only
emit from the normal Node typecheck configuration confirmed private
Pix/RemotePix constructors.

Do not treat M4's review gate as passed until the target CI build executes the
instrumented trap/resource cases. The browser fatal-retirement test is now
wired into the mandatory Playwright step and imports the separately built
`dist-instrumented` module, while the page calls the published
`leptonica-wasm/worker` adapter and redirects only its Worker constructor to
that test entry. The fatal session asserts the adapter calls the native
`terminate()` exactly once; a separate delayed-teardown session keeps the
terminal worker observable long enough to prove its no-reentry response. This
has not run locally: project execution discipline keeps the emsdk/native build
and browser installation in CI, so `dist-instrumented` was not generated here.
The build script supports the isolated flavor, but that is not a claim of a
technical access-control barrier against someone invoking it locally. CI must
prove that the real `__builtin_trap()` rejects
both concurrent requests within the test window, invokes production adapter
teardown, leaves the separately probed terminal worker responsive until client
teardown, rejects later session calls at the dispatch boundary, and does not
poison a fresh module instance. It does not claim detection of an arbitrary DOM
Worker that exits silently without an error or terminal message.
Allocation-stage, multipage, repeated-worker, and production-cross-check cases
remain incomplete.

A 2026-09-07 target-level source audit traced the complete injected path rather
than relying only on the test names. `testArmFault("fatalTrap")` is compiled
only in the isolated instrumentation flavor and causes the next curated
`fromRGBA()` call to execute `__builtin_trap()`. The resulting
`WebAssembly.RuntimeError` crosses the single trap-aware native boundary, which
poisons every live wrapper and abandons the heap without destructor re-entry.
The worker catches that same runtime trap, emits an explicit session-fatal
control response, and records a terminal error before processing any later
queued request. On the client, a fatal response is authoritative even for a
stale request id: `markTerminated()` poisons proxies, rejects the entire pending
map, and then invokes the adapter teardown through an idempotent gate. The
browser case posts both loads synchronously before awaiting either one, bounds
their settlement, checks one production `Worker.terminate()` call, probes the
worker-side terminal gate with physical termination deliberately delayed, and
loads a pixel through a separate clean module. No additional runtime change was
justified by this audit; execution of that exact chain in target Chromium is
still CI-only.

The first CI run from commit `06166cd9fecbc89efe5a2ea7b32253354ea42657`
stopped before Playwright because the curated symbol-map gate found
`jpeg_read_header`. The new document-cleaning primitives do not call a JPEG
decoder; the regression came from `toJPEG()` calling Leptonica's
`pixWriteMemJpeg()`, whose implementation shares `jpegio.c` with JPEG read
entry points. The pending fix replaces that call with a compression-only
libjpeg destination adapter while preserving the existing curated `toJPEG()`
contract. A source-level test now rejects a direct return to
`pixWriteMemJpeg()` and requires the compression lifecycle to retain
`jpeg_destroy_compress()`, but only a clean CI rebuild can prove that decoder
symbols are absent from the final optimized WASM.

The instrumented allocation sweep counts Leptonica-managed allocations,
including the adapter state, converted PIX, row buffer, and output buffer. It
does not count or fault-inject libjpeg-turbo's internal `malloc` allocations;
their release is delegated to `jpeg_destroy_compress()` and is supported by
fixed-source lifecycle review, not by the Leptonica live-block counters. The
named destination-growth fault separately proves cleanup of the adapter-owned
current output buffer. CI still must compile this path, run the allocation and
growth-fault cases, verify a complete grown JPEG stream, and re-run the
decode-symbol gate before this evidence is considered closed.

The follow-up CI run from commit `61d08799893c1ae974b3763328c9355d2740d736`
still stopped at the same gate. Its default symbol map contained
`jpeg_read_header`, `jpeg_CreateDecompress`, `jpeg_stdio_src`, and
`jpeg_resync_to_restart`. Fixed-source inspection traced the remaining edge to
background normalization: `pixGetBackgroundGrayMap()` calls
`pixMorphSequence(..., 0)`, whose compiled body retains a runtime debug call to
`pixDisplay()`. `NO_CONSOLE_IO` controls diagnostic messages only and does not
remove that display branch. The pending fix gives curated builds an inert
`pixDisplay()` definition so the static linker does not extract Leptonica's
desktop `writefile.c` object and generic decoder graph. Full-ABI builds omit
the override and retain upstream behavior. The source-level contract proves
the intended build split; only a clean CI link and the existing symbol-map
gate can prove that the decoder path is absent from the resulting WASM.

CI run `34092410049` from commit
`e90eee2b9eb2717753273729cf540ed59326f97f` falsified that first isolation
attempt before the symbol gate: defining `pixDisplay()` directly in
`bindings.o` conflicted with the strong definition in
`libleptonica.a(writefile.c.o)`. The subsequent revision instead defines
`__wrap_pixDisplay()` and passes `-Wl,--wrap=pixDisplay` only for curated
links. This leaves the upstream symbol definition untouched, prevents the
debug-only undefined reference from forcing archive extraction, and avoids a
duplicate definition if `writefile.c.o` is independently needed. Full-ABI
builds omit both halves of the wrapper.

CI run `34094334788` from commit
`5f2762008cd47468a9e96a6ae78be569a9b05e42` proved that both default links now
complete, so the duplicate-definition failure is fixed. It also falsified the
claim that `pixDisplay` was the sole extraction edge: the default export gate
still found `jpeg_read_header` and stopped the job before full ABI, runtime,
consumer, bundler, and Playwright steps. The authenticated job log names only
that surviving forbidden symbol; it does not identify the archive member or
undefined reference that extracted it.

The current diagnostic revision adds an opt-in
`--link-diagnostics` build argument. Its output is restricted to
`tmp/link-diagnostics/`, passes lld `--why-extract`, traces `pixRead` and
`jpeg_read_header`, and uploads the extraction report from CI even when the
symbol gate fails. Run `34103003138` established the surviving extraction
chain as `bindings.o -> adaptmap.c.o -> morphseq.c.o -> morphapp.c.o ->
compare.c.o -> pdfio1.c.o -> pdfio2.c.o -> jpegio.c.o`. The edges cross
unrelated functions co-located in the same Leptonica translation units; they
do not represent a curated call to a decoder.

The next falsifiable revision preserves Leptonica's codec-enabled API instead
of replacing upstream behavior with a pdfhow-specific build. Leptonica is
compiled with function/data sections and curated links explicitly enable
section GC. Full ABI uses the same complete source and codec configuration and
continues exporting the upstream functions. This is intentionally narrower
than disabling JPEG/PNG (which would change the existing general `toPNG()`
contract) and more systematic than wrapping each incidental PDF/read/debug
symbol. The target symbol-map gate remains authoritative: if any decoder
section is genuinely reachable, CI must still fail. The report is outside
`dist`, package files, release
tarballs, and hash manifests. The current upstream wasm lld option table and
tests contain both `--why-extract=` and `--trace-symbol`; the exact pinned
emsdk 6.0.9 binary is intentionally not installed locally, so target-toolchain
acceptance and report contents still require CI execution. Until that evidence
exists, no additional wrapper or source substitution is justified. In
particular, the repository does not yet wrap `pixRead` or weaken
`scripts/check-exports.mjs`.

A local Vite preflight also found that Vite 7.2 does not resolve this
repository's own bare package self-reference from the nested `tests/e2e` dev
server root: both browser pages returned HTTP 500 before loading any test code.
`tests/e2e/vite.config.mjs` now derives the exact browser/default
`./worker` target from `package.json`, aliases only
`leptonica-wasm/worker` to that generated production adapter, and excludes the
specifier from dependency optimization so Vite can still transform the
adapter's literal Worker constructor. The package-contract and bundler-matrix
gates remain responsible for consumer-side exports resolution; this E2E alias
only makes the real-browser runtime test address the export-selected file. A
local resolver probe now reaches `dist/types/worker/index.js`, while complete
transform and Chromium execution remain CI-only because `dist` is intentionally
absent locally.

### Current fatal-retirement evidence ledger (2026-09-07)

| Requirement | Current evidence | Status |
| --- | --- | --- |
| A real Chromium test uses the production browser adapter and target-WASM trap | `tests/e2e/fatal-page.mjs`, `instrumented-worker.mjs`, and `e2e.browser.spec.ts` are wired into a dedicated Playwright job; Vite resolves the bare test import through the browser/default `./worker` export target; CI freezes the production and instrumented artifacts once, then the browser and OOM jobs consume that same artifact independently | Implemented and locally resolver/topology-checked; Chromium execution pending |
| One fatal response settles every concurrent pending request | Unit coverage passes; the browser case requires both promises to reject within 2 seconds | Locally simulated; target-browser proof pending |
| Fatal retirement tears down once and blocks later dispatch/WASM re-entry | Unit coverage passes; browser test separately checks production teardown and a delayed physical-termination terminal gate | Locally simulated; target-browser proof pending |
| A fresh Worker/module remains usable after another instance traps | Browser test creates a separate clean instance and checks a 1x1 load | CI-only proof pending |
| Curated build remains decode-free after preserving `toJPEG()` | Compression-only JPEG path plus curated-only `--wrap=pixDisplay` isolation are present; run `34094334788` linked both default builds but still found `jpeg_read_header` | Not achieved; extraction diagnostics are prepared but require CI execution |
| Recoverable JPEG allocation and destination-growth failures leave no tracked native blocks | Instrumented allocation sweep and named growth fault are present | Target-WASM execution pending |
| General-purpose binding boundary is preserved | No `documentClean`, pdfhow profile, fixed operation order, output policy, or deskew policy appears in the package API | Proven by current source inspection |
| Feasible local contracts pass without a native/WASM rebuild | Full Vitest reports 89 passed and 58 skipped; focused source/cache/package coverage reports 49 passed; typecheck, release contract, task validation, and `git diff --check` pass | Proven locally for source-only coverage; artifact-dependent tests remain skipped/unverified |

The latest completed remote evidence at this checkpoint is feature commit
`7a033e142966a60b3889240c71f8651bee41f4fc`, CI run `34117174428` (job
`101726682649`). Default and full-ABI builds, curated export/method/smoke gates,
goldens, and the normal target-WASM tests passed. The combined instrumented
step then found four real recoverable-allocation leaks:
`cleanBackgroundToWhite` index 4 (+1 block/+200 bytes), `sauvolaTiled` index 6
(+1/+43,808), `selectByArea` index 0 (+6/+720), and
`maskOverColorPixels` index 2 (+2/+24). Because that step both built the
instrumented artifact and ran the independent OOM sweep, GitHub skipped the
later Playwright step even though the artifact build itself had succeeded.
The current uncommitted workflow revision separates those concerns at the job
boundary. The main CI job freezes `dist/` and `dist-instrumented/` immediately
after the isolated build and exposes an output only when that upload succeeds.
Dedicated browser and OOM jobs each depend on that output and download the same
artifact, but use separate runners and timeout budgets, so failure or stalling
in either runtime gate cannot mask the other. Both jobs are also explicit
prerequisites of `dispatch-builder`, so a runtime failure cannot race ahead of
the external release dispatch. This does not waive or hide any leak: the same
four failures will still fail the workflow until their ownership defects are
repaired. A new CI run is still required to execute Chromium and close the
target-browser evidence rows above. The repository's active `main` ruleset was
read-only checked on 2026-09-07 and currently enforces deletion/non-fast-forward
protection but no required status checks; PR merge enforcement therefore remains
an external repository-governance gap rather than a property this workflow can
prove.

The final independent DBS chatroom review is complete for this source-only
submission boundary. Nancy Leveson, Karl Popper, and Barbara Liskov each
created an agent-owned goal as their first action, included the required
disconnect/429/transient-5xx recovery policy, inspected the shared archive
helper and its counterexample tests, and explicitly completed their goals.
All three reported that the change is ready to submit with no new integrity,
concurrency, or abstraction-boundary blocker. They agreed that the remaining
gap around an already damaged archive is availability rather than silent
integrity: the helper fails closed, and the recorded recovery procedure is to
remove that cache entry before retrying. Popper and Liskov suggested a fuller
helper-level damaged-cache recovery regression as a non-blocking follow-up.
This review does not upgrade the 58 skipped artifact-dependent tests, target
Chromium, native oracle, target-WASM allocation sweep, multipage retention, or
consumer/release evidence; those remain explicitly unproved.

## M5: External real-scan comparison (R8)

- [ ] Obtain a rights-cleared corpus and record storage/upload permissions.
- [ ] Keep the pdfhow profile in an external adapter or benchmark harness;
  do not add it to leptonica-wasm's API.
- [ ] Pin JS algorithms, source commits, dataset hashes, parameters, quality
  procedure, runtime, browser/device, and memory sampling before measuring.
- [ ] Compare equivalent JS and composed WASM paths on identical decoded
  inputs, including background, Sauvola, area, color-mask, and optional deskew
  variants as appropriate.
- [ ] Record cold/first/steady median and p95 ms/MP, output costs, single-page
  and multipage memory, raw/gzip sizes, and quality/OCR or declared proxy.
- [ ] Publish limitations and an evidence-based go/no-go recommendation.

Review gate: the report is reproducible and does not present 91 ms/MP, 44.7
ms/MP, or any dewarp bytes/pixel estimate as measured current evidence.

## M6: Final audit and ordinary PR (R1-R9)

- [ ] Map every acceptance criterion to commands, artifacts, executed counts,
  commits, and CI URLs from the final head.
- [ ] Synchronize with current origin/main without force pushing and rerun all
  applicable gates after the final change.
- [ ] Update README and durable specifications for the exact public surface.
- [ ] Audit diff scope, generated assets, credentials, provenance, and release
  privacy; preserve unrelated work.
- [ ] With applicable authority, create coherent commits and an ordinary PR.
- [ ] Monitor CI to terminal results, retry transient service failures, repair
  in-scope failures, and reverify.
- [ ] Merge or release only with the separately required review/authority.

## Local validation

Lightweight checks:

    python3 .trellis/scripts/task.py validate .trellis/tasks/09-06-document-cleaning-pipeline
    pnpm run typecheck
    pnpm test
    pnpm run test:release-contract
    git diff --check

Native/WASM builds, oracle runs, Git-source preparation, browser E2E, memory,
reproducibility, and release builds remain CI work. Record skipped local suites
as unverified rather than passing.
