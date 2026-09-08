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
  failure behavior was not justified at the general Leptonica boundary. Later
  target-WASM allocation sweeps exposed additional upstream partial-allocation
  cleanup paths, so the current canonical patch covers 15 source files without
  introducing a consumer-specific policy API. Its SHA-256 is
  `239040d17ba4c177fc905f675055892fa5ccf4ddcc1f1e8a13bc88ca8e24ecf8`; the
  patched source-tree SHA-256 is
  `99966c33881338ceb66941a3a97a6b297044a85274ef2c833356f237c98a70e8`.
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
- [x] Enforce zero retained owned native resources after recoverable failures.
- [ ] Document separate WASM-capacity, JS-heap, and process-RSS budgets.
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

The latest 2026-09-07 lightweight run produced 102 passing and 58 skipped
Vitest cases, and separately passed typecheck, release-contract tests, task
validation, and `git diff --check`. The 58 skipped cases belong to five
artifact-dependent files because `dist`/`dist-instrumented` are absent; those
tests are unverified, not passing. A strict declaration-only emit with
`stripInternal`, the repository's ambient Emscripten declaration, and no
generated `dist` artifacts confirms the public `RemotePix` dimensions, private
`RemotePix` constructor, and argument-bearing `WorkerSession` constructor.

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
their settlement, checks one production `Worker.terminate()` call, records the
adapter's direct `Worker.postMessage()` count before and after a later rejected
call and again after delayed tasks drain, probes the worker-side terminal gate
with physical termination deliberately delayed, and loads a pixel through a
separate clean module. No additional runtime change was justified by this audit;
execution of that exact chain in target Chromium is still CI-only.

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

The recoverable-OOM patch passes the production-equivalent
`git apply --check --whitespace=error-all` preflight against an unmodified
Leptonica 1.87.0 tree. The public in-place `pixSeedfill4BB()` and
`pixSeedfill8BB()` primitives remain non-transactional on allocation failure:
caller-owned PIX data may be partially modified and the caller-owned stack may
retain queued segments. Current internal callers abort and destroy that stack;
rollback or draining arbitrary caller state is a separate upstream API choice.

The fatal Worker case now carries two CI-only falsification signals without
changing production exports or protocol: native/WASM code writes a breadcrumb
immediately before `__builtin_trap()`, and a test-only module wrapper counts
entries into `fromRGBA`. The production-adapter Worker first creates one live
`RemotePix`, arms the next entry, and must report two entries plus one native
trap on the same fatal response that retires the adapter. The pre-existing
proxy must be poisoned and reject without another post. The delayed-teardown
probe independently requires its one entry and one trap to remain unchanged
after a direct post-fatal message. The production adapter path also drains
delayed tasks, calls both cleanup methods, and still requires physical teardown
exactly once.

The final source-level completion audit caught one browser-harness blocker
before submission: `runTerminalGateProbe()` referenced the probe session's
private `messages` array outside its lexical scope. A real run would therefore
have thrown `ReferenceError` after receiving the direct post-fatal response,
before Playwright could assert the native breadcrumb or zero-reentry counter.
The session now exposes only a `firstFatal()` accessor, and the source contract
locks out the stale expression. A follow-up adversarial review then found that
the first load accepted any rejection: a recoverable pre-WASM error could leave
the named fault armed and allow the direct probe to become the first call that
actually trapped, producing matching 1/1 counters without proving post-fatal
zero re-entry. The harness now captures and validates the first fatal response
and the session's fatal-retirement rejection before dispatching the probe.
Syntax checks and the full local Vitest suite pass after both corrections;
actual Chromium execution remains pending.
An additional falsification review found that the production adapter's
`postMessage` counter was sampled before the deliberate task-drain delay, so a
queued post could occur after the asserted sample. The page now samples again
after delayed tasks and cleanup, the browser assertion requires that final
count to remain unchanged, and the local session test verifies the same
invariant across a timer turn.

### Current fatal-retirement evidence ledger (2026-09-08)

| Requirement | Current evidence | Status |
| --- | --- | --- |
| A real Chromium test uses the production browser adapter and target-WASM trap | Run `34169822640` identity-checked the frozen production/instrumented artifact and ran two Playwright tests successfully; the production Worker observed two WASM entries and one native trap, while the terminal-gate Worker remained at one entry and one trap before and after its probe | Proven on `66066516835dcbe4c72a86189a7100a358687760`; replacement final-head run required |
| One fatal response settles every concurrent pending request | Run `34169822640` passed the real-browser assertion that both requests reject within 2 seconds with the fatal WebAssembly-trap reason | Proven on `66066516835dcbe4c72a86189a7100a358687760`; replacement final-head run required |
| Fatal retirement tears down once, poisons live handles, and blocks later dispatch/WASM re-entry | Run `34169822640` passed the poisoned-proxy, unchanged post-count after drain, one production teardown, one terminal-gate teardown, and no-reentry probe assertions | Proven on `66066516835dcbe4c72a86189a7100a358687760`; replacement final-head run required |
| Fatal retirement is request-type independent | Source inspection shows `run`, every extract/query method, metadata access, disposal, and `load` enter the same `Leptonica.callNative()` boundary; `wireWorker` classifies fatal errors around the complete request switch and `WorkerSession` treats a fatal response as session-wide state; a source-only unit injects a query trap and proves a later extract is refused without another query entry | Architectural invariant established locally; real target-WASM injection currently covers only `load`/`fromRGBA`, not per-operation trap execution |
| A fresh Worker/module remains usable after another instance traps | Run `34169822640` passed the real-browser fresh-session assertion for a 1x1x32 pixel and exactly one teardown | Proven on `66066516835dcbe4c72a86189a7100a358687760`; replacement final-head run required |
| Curated build remains decode-free after preserving `toJPEG()` | Run `34169822640` passed both curated builds, linker export/symbol checks, curated smoke, and the full-ABI escape-hatch checks | Proven on `66066516835dcbe4c72a86189a7100a358687760`; replacement final-head run required |
| Recoverable allocation and JPEG destination-growth failures leave no tracked native blocks | Run `34169822640` passed all 15 target-WASM fault-injection cases, including the three paths that retained resources in run `34146706412` | Proven on `66066516835dcbe4c72a86189a7100a358687760`; replacement final-head run required |
| General-purpose binding boundary is preserved | No `documentClean`, pdfhow profile, fixed operation order, output policy, or deskew policy appears in the package API | Proven by current source inspection |
| Feasible local contracts pass without a native/WASM rebuild | Full serial Vitest reports 146 passed and 58 skipped; the focused package/trap-retirement/instrumentation run reports 99/99; typecheck, strict declaration emit, release contract, task validation, and `git diff --check` pass | Proven locally for source-only coverage; artifact-dependent tests remain skipped/unverified |

The completed remote evidence at that checkpoint was feature commit
`468f15cb14b51630ac2c4556f191920a6b005829`, CI run `34146706412`.
`release-set`, `native-oracle`, and `reproducibility` passed. The main `ci` job
also passed both production builds, export/smoke gates, goldens, normal tests,
the instrumented target-WASM build, artifact upload, and mutation smoke before
the consumer fixture's `attw --pack` path failed. The current workflow
reactivates the pinned emsdk in that shell; this awaits CI verification.

Both separated runtime jobs consumed and identity-checked the frozen artifact.
The browser job failed its generated Worker-file guards before Playwright was
installed, so it supplies no Chromium result. The workflow now generates and
verifies `dist/types/worker/index.js` and `worker.mjs` before upload. The
resource job genuinely executed 15 cases: 12 passed, while
`cleanBackgroundToWhite` retained 1 block/16 bytes, `sauvolaTiled` retained 2
blocks/4,148 bytes, and `selectByArea` retained 5 blocks/640 bytes. The current
15-file canonical Leptonica patch addresses those observed upstream cleanup
paths and reproducibly yields patched-tree digest
`99966c33881338ceb66941a3a97a6b297044a85274ef2c833356f237c98a70e8`, but
neither its target-WASM leak closure nor the browser fatal-retirement behavior
is proved until a new CI run executes both jobs. `compare`,
`fixed-commit-consumer`, and `dispatch-builder` were skipped. The repository's
active `main` ruleset was read-only checked on 2026-09-07 and currently
enforces deletion/non-fast-forward protection but no required status checks;
PR merge enforcement therefore remains an external repository-governance gap
rather than a property this workflow can prove.

The latest completed remote evidence at this checkpoint is feature commit
`fe3a4abc050c4d771aea8d701799525f787e686c`, CI run `34168986320`.
`release-set` passed, but `native-oracle` and `reproducibility` independently
stopped source preparation because `vendor/versions.json` retained the former
patched-tree value
`454614820a2f9f32a0fa036c73986cbaf3308ae6d6b9c7e9b8a63fa9088bbec1`; each
job computed
`99966c33881338ceb66941a3a97a6b297044a85274ef2c833356f237c98a70e8`. The
main `ci` job and all artifact-dependent jobs were skipped. Two independent
fixed-commit source extractions plus a fresh `applySourcePatches()` replay
locally reproduce the CI value from the pinned upstream tree and unchanged
canonical patch. The manifest now records the reproduced value, but this
metadata correction still requires a new CI run before any browser, allocation,
consumer, comparison, or dispatch evidence can advance.

The next completed remote evidence is feature commit
`66066516835dcbe4c72a86189a7100a358687760`, CI run `34169822640`.
`release-set`, `native-oracle`, `reproducibility`, all production/full-ABI and
target-WASM gates through the release-candidate pack, `browser-e2e`, and
`instrumented-resource-failures` passed. Chromium executed both tests, including
the production-adapter fatal path and fresh-session recovery. The resource job
passed 15/15 cases. The main job then failed only when the fresh tarball
consumer rejected `sourceTreeDirty:true`: earlier CI steps had created
untracked `dist-o2/` and `dist-instrumented/`, which were expected build outputs
but were not ignored. The bounded correction adds exact root-level ignores and
a real-Git positive/negative regression test; it does not move the provenance
check earlier or exempt arbitrary `dist-*` paths. `fixed-commit-consumer`,
`compare`, and `dispatch-builder` were skipped, so M3 and the overall final gate
remain open. The matching secret scan completed successfully.

The final DBS cross-audit found no new fatal-retirement implementation defect.
The concurrency review confirmed monotonic session retirement, settlement of
all pending requests, proxy poisoning, no later dispatch/WASM re-entry,
idempotent teardown, and fresh-Worker recovery. The provenance review found one
low-risk blind spot in the new regression: it did not prove the ignore rules
were root-anchored. The test now also requires nested `src/dist-o2/` and
`src/dist-instrumented/` paths to remain visible as dirty source. The
systems-safety review keeps final-head CI and repository release governance
explicitly open; neither is converted into a local pass.

The latest independent DBS chatroom review is complete for this source-only
boundary. Nancy Leveson's systems-safety audit initially raised a blocking
claim that the canonical patch failed strict whitespace application. The judge
replayed the production-equivalent command against the unmodified 1.87.0 tree;
it exited successfully, so that specific objection was falsified rather than
carried forward. Her broader warning remains valid: the patch touches general
Leptonica ownership paths and requires the independent target-WASM sweep. Karl
Popper's falsifiability audit found that a fatal response alone could not prove
the native trap or zero post-fatal WASM re-entry; the test now adds the native
pre-trap breadcrumb and module-entry counter described above. Barbara Liskov's
replacement-instance audit found no structural abstraction leak because those
signals are confined to the test macro and CI-only Worker and do not alter the
published API or production protocol.

A second 2026-09-07 generality audit examined the exact boundary of that
evidence. Leveson's control-structure review, Popper's alternative-explanation
search, and Liskov's abstraction review agreed that `load`, `run`, `extract`,
and `query` converge on the same trap-aware native boundary and top-level Worker
fatal gate. They also agreed that the unexecuted browser harness injects only at
`fromRGBA`, so it must not be reported as though real target-WASM traps had been
independently exercised inside `run`, `extract`, or `query`. The judge therefore
kept the generic implementation, rejected operation-specific public or protocol
hooks, and records the narrower runtime-evidence claim above.

A follow-up artifact-identity audit considered whether the two runtime jobs
must duplicate every Leptonica provenance field from `build-report.json`. The
pinned `actions/download-artifact` implementation defaults to the current
repository and current workflow run when no token or run id is supplied, and
its pinned revision fails on an artifact digest mismatch by default. Together
with `needs: ci`, the same-SHA downstream checkouts, the producer's strict
pin/patch/source-tree validation, and the existing report-to-WASM SHA check,
this is sufficient for the present non-adversarial CI boundary. An independent
shared verifier of `sourceIdentitySha256` remains a possible defense-in-depth
improvement, but copying commit, tree, patch-set, and patch-list comparisons
into both YAML jobs would create a second representation-dependent contract
without proving that the binary was linked from those sources. The review
therefore found no additional blocker and made no workflow change.

Judge ruling: the source design is bounded and locally testable, but it is not
production-proven. The real Chromium job, corrected target-WASM resource sweep,
consumer fixture, and remaining downstream jobs must run on one new commit SHA
before any go/ready claim. This review does not upgrade the 58 skipped
artifact-dependent tests or any CI-only evidence.

The subsequent candidate commit
`37755e913465e86375e09154b8ccc2a10f1bb3c6` ran as CI `34172195859` on
2026-09-08. It passed release-set, native-oracle, reproducibility, both
production builds, exports, smoke, goldens, target-WASM tests, bundling,
determinism, package creation, real Chromium fatal retirement, and all 15
instrumented resource-failure cases. Secret scan `34172195864` passed. The main
job failed only in `Fresh tarball consumer`: the existing textual lockfile
guard treated pnpm's expected relative references to the selected tarball as a
worktree dependency. `compare` and `dispatch-builder` therefore skipped; the
PR-only `fixed-commit-consumer` skip is expected by design.

A new DBS security/falsification review rejected a proposed substring
exception because comments, unrelated local locators, and wrong Git identities
could spoof it. The accepted correction uses pinned `yaml@2.8.1` to parse pnpm
lockfile version 9 with duplicate-key, alias, warning, and explicit-tag
rejection. It binds the root importer dependency plus every package, resolution,
and snapshot identity to the exact selected source; for tarballs it also binds
`resolution.integrity` to the candidate file's actual SHA-512 bytes. It rejects every additional
local or directory source, canonicalizes filesystem identities before boundary
checks, and verifies the installed package is inside the independent consumer
but outside this worktree. Its test matrix includes real pnpm 10.34.5 tarball
generation plus one-field-at-a-time tarball/Git identity mutations, adversarial
YAML tags and mapping keys, additional identities, local locators, and canonical
path/symlink cases.

PR head `61505a53f37a1daa652b63dbcc540a1d42bfa63b` was then evaluated by CI
`34174762665`; the pull-request workflow itself checked out synthetic merge SHA
`5bfaf27dff7b936f25dbf24fb683ba58b48bed63`. The structural lockfile gate,
type checks, package build, and browser bundling completed, but the post-bundle
verifier rejected Emscripten's literal `"file://"` protocol test as though it
were a concrete build-host path.
The independently uploaded browser fatal-retirement and all 15 resource-failure
checks passed; secret scan `34174762663` passed. The follow-up verifier uses
Vite's ESTree parser rather than raw text matching, but deliberately scopes the
package contract to actual `new URL(...)` resource references through unshadowed
`URL` and `self` globals. Arbitrary diagnostic strings, protocol checks, and
other consumer content are not treated as a leptonica-wasm policy violation.
Every browser-base resource URL must resolve to the expected asset, and every
unshadowed `Worker` constructor must connect directly to such a URL, so a valid
decoy cannot hide an invalid operational sink. Static references may use
literals, templates, `+`, or lexically scoped constants; mutable
`String.raw`/`.concat()` calls are non-static, direct global `URL`/`Worker`
constructor writes are rejected, and temporal-dead-zone plus shadowing checks
prevent a textual lookalike from satisfying the gate. Relative resource
references use WHATWG URL resolution and must reach the expected same-directory
asset; explicit schemes and authorities, including protocol-relative and
sentinel-origin inputs, plus percent-encoded path separators, are rejected
before filesystem resolution.
Browser URL preprocessing removes ASCII tabs/newlines and trims only
leading/trailing C0 controls or ASCII spaces; it preserves non-ASCII whitespace
such as NBSP. The emitted curated and full-ABI WASM files are also compared
byte-for-byte with their respective installed package assets, so correct paths
cannot conceal a cross-variant copy. Independent regressions cover disconnected
decoys, extra invalid URLs, direct constructor mutation, mutable string-method
composition, lexical shadowing, constant and class-heritage TDZ, stringified
fake URLs, encoded separator traversal, invalid authorities, cross-variant
references, and cross-variant bytes. This remains a generated-bundle integrity
contract, not a JavaScript security sandbox. A final concurrency audit then
reproduced a same-turn
result-publication race in the generic `WorkerSession` transport: after an
internal request resolved but before its public continuation ran, a
synchronously delivered fatal response could retire the session and still let
the earlier continuation publish a fresh proxy or value. Successful `init`,
`load`, `run`, `extract`, and `query` continuations now re-check terminal state
before publication, with regressions for fatal retirement across every result
shape and for normal close. Final local validation therefore reports 146 tests
passed and 58 artifact-dependent tests skipped; the focused package,
trap-retirement, and instrumentation set reports 99/99. Node/web type
checking, release-contract tests, Trellis task validation, and `git diff --check`
pass. CI `34188160101` subsequently passed the real-browser fatal-retirement
case, all 15 instrumented resource-failure cases, both WASM builds and smoke
checks, tests, bundler checks, determinism, and release packing. Its fresh
tarball consumer caught an overconstrained `main.mjs` rule because the real
bundle retains both the Worker URL and the curated WASM URL. The replacement
gate must accept that exact two-asset set while continuing to reject all other
resource URLs, then complete all downstream jobs on one synthetic merge SHA.

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
