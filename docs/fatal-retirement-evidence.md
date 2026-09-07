# Browser fatal-retirement evidence

This note records the evidence boundary for the browser Worker fatal-retirement
work. It does not claim that the document-cleaning pipeline or release is ready.

## Current CI status

The pull-request run associated with head commit
`fc639aa578c3b912a664027507b6823fbfb4e987` (run `34129740682`, September 7,
2026) failed before the runtime jobs. `native-oracle` and `reproducibility`
reported that the expected patched Leptonica tree digest was
`6b1845df90c5de803639c5cff91317590409c9d67203c40a9539138c3a27779f`, but the
actual digest remained the upstream value
`0bca39eb8c7127ef398ebc9be7946fb47c0db9b1e7394bd752189bdc2b2cf08c`.
Consequently, `browser-e2e`, `instrumented-resource-failures`, `compare`, and
`dispatch-builder` were skipped. That run supplies no target-WASM browser
evidence.

The cause was environment-specific: `git apply` was run from a staging
directory nested under the checkout. Git discovered the parent worktree,
filtered all patch paths relative to the current subdirectory, and returned
success without modifying the staging tree. The local correction runs from the
discovered worktree root with an explicit staging-directory prefix. A regression
test covers the repository-nested case, and a fixed-commit Leptonica archive now
produces the expected patched tree digest through the production source
preparation path. Empty patch sets remain a Git-free no-op.

The runtime evidence jobs are gated by the successful upload step rather than
the final result of the main `ci` job. Therefore, if a later `ci` step fails,
both jobs still consume the frozen artifact and report their evidence
independently. Their `!cancelled()` status check preserves that behavior for a
failed dependency without overriding an explicit workflow cancellation. The
workflow contract test locks both the job output and the downstream guards.

The follow-up run for head commit
`229be252294d84304a37b6379199023cb961b04c` (run `34136217383`, September 7,
2026) proved that source preparation now advances into both dependency builds.
`release-set` passed, but two independent build defects then stopped the
runtime graph:

- `native-oracle` failed while archiving Leptonica because the native CMake
  invocation explicitly supplied relative `CMAKE_AR=ar` and
  `CMAKE_RANLIB=ranlib` values. CMake persisted them as nonexistent paths under
  the Leptonica source directory. The correction asks the selected host
  compiler for its archiver and ranlib, resolves both to executable canonical
  paths, supplies those absolute paths to CMake, and binds the same paths and
  version output into the dependency cache identity.
- `reproducibility` completed dependency compilation and installation, then
  rejected libpng's legitimate `bin/libpng-config -> libpng16-config` link. The
  correction keeps source-tree hashing strictly link-free while giving
  dependency install trees a separate digest contract. That contract permits
  only internal relative links to regular files and binds the entry type, exact
  link text, resolved root-relative target, and the complete target tree. It
  rejects absolute, escaping, dangling, looping, directory, and special-file
  targets on both cache write and cache read.

The main `ci`, `browser-e2e`, `instrumented-resource-failures`,
`fixed-commit-consumer`, `compare`, and `dispatch-builder` jobs were skipped in
run `34136217383`. It therefore also supplies no target-WASM browser evidence.
The install-tree regression tests additionally prove that changing only link
spelling, changing target bytes, replacing a link with a regular file, or
redirecting it to an equal-content sibling invalidates the cache, while the
legacy regular-file digest and strict source-tree policy remain unchanged.

The next run for head commit
`b49f27fa3095832bc694c62febde660335669ce8` (run `34145946482`, September 7,
2026) confirmed both dependency corrections. `release-set` passed, and
`native-oracle` completed its host build, golden generation, and artifact
upload successfully. Both `reproducibility` and the main `ci` job then completed
the target dependency builds and stopped in `scripts/build.mjs` while recording
the linked WASM digest: `linkOutputs()` called `createHash()` without importing
it from `node:crypto`. This is a JavaScript build-driver defect after dependency
installation, not a recurrence of the native tool or install-tree link defects.
`browser-e2e`, `instrumented-resource-failures`, `fixed-commit-consumer`,
`compare`, and `dispatch-builder` were skipped, so run `34145946482` still
provides no target-WASM browser evidence.

The latest completed run at this checkpoint is head commit
`468f15cb14b51630ac2c4556f191920a6b005829` (run `34146706412`, September 7,
2026). It materially advanced the evidence boundary: `release-set`,
`native-oracle`, and `reproducibility` passed; the main `ci` job passed its
typecheck, production and full-ABI builds, export checks, smoke tests, goldens,
normal tests, instrumented target-WASM build, runtime-artifact upload, and
mutation smoke. It then failed in the consumer fixture when `attw --pack`
invoked `npm pack`. The log does not expose `npm pack`'s nested stderr, so the
current diagnosis is based on the workflow boundary: package prepack invokes
the WASM build, while the fixture ran in a later shell that did not source the
pinned emsdk environment. The current workflow revision reactivates the pinned
emsdk immediately before the fixture and checks that `emcc` resolves below the
checkout's pinned `tmp/emsdk/` tree. This diagnosis and correction have not run
in CI yet.

Both independent runtime jobs downloaded and verified the frozen artifact.
`browser-e2e` then stopped at its initial `test -f` guards because the uploaded
`dist/` lacked the generated `dist/types/worker/index.js` and/or
`dist/types/worker/worker.mjs`; the log ends before Playwright installation, so
no Chromium test executed. The current workflow revision runs
`scripts/gen-types.mjs` and verifies both files before artifact upload. This is
an artifact-assembly correction, not browser fatal-retirement evidence.

`instrumented-resource-failures` did execute 15 target-WASM cases: 12 passed
and three failed. The exact retained-resource observations were
`cleanBackgroundToWhite` failure index 5 (+1 block/+16 bytes),
`sauvolaTiled` (+2 blocks/+4,148 bytes), and `selectByArea` failure index 0
(+5 blocks/+640 bytes). The current uncommitted canonical Leptonica patch
expands recoverable allocation cleanup for those upstream paths; its patch
SHA-256 is
`239040d17ba4c177fc905f675055892fa5ccf4ddcc1f1e8a13bc88ca8e24ecf8`, and
the resulting source-tree SHA-256 is
`454614820a2f9f32a0fa036c73986cbaf3308ae6d6b9c7e9b8a63fa9088bbec1`.
Fresh archive applications reproduce that tree locally, but only a new
instrumented target-WASM CI run can show that the three observed leaks are
closed.
The patch also passes the production-equivalent strict preflight
`git apply --check --whitespace=error-all` against an unmodified 1.87.0 source
tree. This command and target-tree pairing is the relevant whitespace
evidence; inspecting added or removed blank lines in the patch text alone is
not.

The connected-component repair deliberately does not promise transactional
failure semantics for the public in-place `pixSeedfill4BB()` and
`pixSeedfill8BB()` primitives. If a later segment allocation fails, the
caller-owned PIX may already be modified and its caller-owned stack may still
contain queued segments. Existing internal callers treat NULL as terminal and
destroy the stack, so the observed document-cleaning leak is covered. Rolling
back pixels or draining arbitrary caller state would be a separate upstream API
decision, not a bounded cleanup fix.

A source-level completion audit found that the terminal-gate page originally
read its captured `messages` array outside the closure that owned it. That
would have raised `ReferenceError` after the direct probe and prevented the
Chromium assertion from observing either counter. The probe session now
exposes a narrow `firstFatal()` accessor, and the source contract rejects the
old out-of-scope expression. A follow-up adversarial review found a second
false-positive path: the page accepted any rejection from the first load, so a
recoverable pre-WASM error could leave the fault armed and let the direct probe
become the first request that actually trapped. The page now freezes and
validates both the first fatal response and the session's fatal-retirement
error before sending the probe. These corrections pass the local syntax and
unit gates, but they do not convert the still-unexecuted Chromium path into
runtime evidence.

A further falsification pass found that the production-adapter assertions and
the native trap counters came from different Worker instances. Both paths
could therefore pass without proving that the production adapter retired in
response to the counted native trap. The production-adapter session now
observes its own raw fatal response alongside the unchanged package adapter.
Its first load succeeds and creates a live `RemotePix`; the test-only Worker
then arms the next `fromRGBA` call, so the same Worker records two native-entry
attempts, one pre-trap breadcrumb, two rejected concurrent requests, a poisoned
pre-existing proxy, and one physical teardown. The separately delayed Worker
still establishes the terminal no-reentry gate with one entry and one trap.
No public API or production protocol field was added.

A final falsification pass found that the production adapter's post counter was
captured before the deliberate task-drain delay. A deferred post could therefore
occur after the asserted sample. The page now samples again after delayed tasks
and both cleanup calls; the browser assertion and a timer-turn unit regression
require the count to remain unchanged.

The CI-only trap is deliberately injected at the `fromRGBA` entry, and the
browser page reaches it through `WorkerSession.load()`. That is one
representative curated-native request path, not a per-operation target-WASM
test of `run`, `extract`, and `query`. Source inspection establishes the shared
control structure: chain operations and Pix extraction/query methods enter the
same `Leptonica.callNative()` retirement boundary, the entire worker request
switch is covered by one fatal classifier and terminal gate, and the client
handles a fatal response as session-wide state independently of request type.
The source-only unit suite also injects a trap through a worker `query` request,
requires a fatal response, and verifies that a later `extract` request is
refused by the terminal gate without another query entry.
This architectural evidence supports a general mechanism claim, while the next
Chromium run can prove only the concrete `load`/`fromRGBA` path it executes. No
operation-specific public API or test-only protocol command is added to blur
that distinction.

## Evidence required from the next CI run

The browser fatal-retirement claim still requires a single new commit SHA whose
`browser-e2e` job actually executes, without skips, against the generated
target-WASM artifact and proves all of the following:

- a real `__builtin_trap()` reached through `load`/`fromRGBA` rejects both
  concurrent pending requests within the timeout;
- a test-only native breadcrumb written immediately before `__builtin_trap()`
  is exactly one; the production-adapter Worker records one successful load
  plus the trapping entry, while the separate terminal-gate Worker remains at
  exactly one entry before and after its post-fatal probe;
- the `RemotePix` created before the production-adapter trap is poisoned and
  rejects locally without another `Worker.postMessage()`;
- the production browser adapter invokes physical Worker teardown exactly once;
- a later client call is rejected without dispatching into the retired Worker,
  with direct `Worker.postMessage()` counts unchanged across that call and after
  delayed tasks and cleanup drain;
- the deliberately delayed-teardown probe receives the Worker terminal response
  and observes no WASM re-entry;
- a fresh session created through the public `leptonica-wasm/worker`
  `createSession()` path can load a pixel and closes with exactly one teardown.

`instrumented-resource-failures` is a separate gate. Its result must be reported
independently: a passing browser fatal-retirement test cannot prove allocation
failure cleanup, and a resource-sweep failure does not erase valid browser
retirement evidence. `native-oracle`, `reproducibility`, the main `ci` job,
`compare`, and `dispatch-builder` must also reach terminal states before making
broader pipeline or release claims.

Heavy target-WASM, native-oracle, Chromium, and allocation-sweep execution stays
in CI. Local checks cover source preparation, contract tests, type checking, and
release-set validation only.
No repository-installed `actionlint` or YAML parser is available locally; the
workflow topology and changed shell fragment are source-tested/syntax-checked,
while GitHub's workflow parser and runner remain the authoritative execution
evidence for the YAML revision.
