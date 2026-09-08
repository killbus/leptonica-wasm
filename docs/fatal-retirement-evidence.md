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

The completed run at that checkpoint was head commit
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
(+5 blocks/+640 bytes). The canonical Leptonica patch in this branch
expands recoverable allocation cleanup for those upstream paths; its patch
SHA-256 is
`239040d17ba4c177fc905f675055892fa5ccf4ddcc1f1e8a13bc88ca8e24ecf8`, and
the resulting source-tree SHA-256 is
`99966c33881338ceb66941a3a97a6b297044a85274ef2c833356f237c98a70e8`.
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

The latest completed run at this checkpoint is head commit
`fe3a4abc050c4d771aea8d701799525f787e686c` (run `34168986320`, September 7,
2026). `release-set` passed, while `native-oracle` and `reproducibility`
independently rejected the same stale patched-source pin: the manifest expected
`454614820a2f9f32a0fa036c73986cbaf3308ae6d6b9c7e9b8a63fa9088bbec1`, and
both jobs computed
`99966c33881338ceb66941a3a97a6b297044a85274ef2c833356f237c98a70e8`. The
main `ci` job and every artifact-dependent downstream job were therefore
skipped, so this run supplies no new browser or allocation evidence. Two
separately extracted fixed-commit trees and a fresh application through
`applySourcePatches()` reproduce the latter digest locally from the pinned
upstream digest and canonical patch. The manifest now records that reproduced
value; the patch digest itself remains unchanged. This metadata correction
still requires a new CI run before any runtime claim can advance.

The follow-up run for head commit
`66066516835dcbe4c72a86189a7100a358687760` (run `34169822640`, September 7,
2026) supplied the missing runtime evidence. `release-set`, `native-oracle`,
`reproducibility`, the curated/full-ABI builds, symbol and export checks,
goldens, target-WASM tests, runtime artifact assembly, mutation smoke, the
consumer fixture, bundler matrix, and same-runner determinism all passed. The
separate browser and resource jobs downloaded and identity-checked the frozen
artifact from that run.

The real Chromium job ran two tests and passed both. Its fatal-retirement case
proved two concurrent requests reject after the target-WASM trap, the
pre-existing `RemotePix` is poisoned, later calls do not add Worker posts even
after delayed tasks and cleanup, and the production Worker's physical
termination plus the terminal-gate client's logical teardown hook each occur
exactly once. The production Worker reported two WASM entries
and one native trap; the separately probed terminal-gate Worker remained at one
entry and one trap before and after the probe. A fresh public Worker session
then loaded a 1x1x32 pixel and closed with one teardown. The independent
resource job passed all 15 target-WASM fault-injection cases, closing the three
retained-allocation failures observed in run `34146706412`.

The main `ci` job failed only after packing, in the fresh-tarball consumer. The
installed tarball was rejected because provenance reported a dirty source
tree. The package was built after CI had created untracked `dist-o2/` and
`dist-instrumented/` directories, while `.gitignore` covered only `dist/`; the
dirty bit therefore described expected auxiliary build output, not modified
source. `fixed-commit-consumer`, `compare`, and `dispatch-builder` were skipped.
The bounded correction ignores only those two root-level generated directories
and adds a real-Git regression test that still detects tracked edits, ordinary
untracked source, and unknown `dist-*` directories. The secret scan for the
same head completed successfully.

The next candidate, commit
`37755e913465e86375e09154b8ccc2a10f1bb3c6` (run `34172195859`, September 8,
2026), repeated the runtime evidence successfully. `release-set`,
`native-oracle`, `reproducibility`, both builds, exports, smoke, goldens,
target-WASM tests, bundler checks, determinism, packaging, `browser-e2e`, and
all 15 `instrumented-resource-failures` cases passed. The secret scan run
`34172195864` also passed. The main job then failed in `Fresh tarball consumer`
because its textual lockfile guard rejected pnpm's legitimate relative
`file:` identities for the exact candidate tarball. That is a consumer-gate
validator defect, not a runtime or packaging failure. `compare` and
`dispatch-builder` were skipped as downstream jobs; `fixed-commit-consumer` is
intentionally skipped on pull requests.

PR head `61505a53f37a1daa652b63dbcc540a1d42bfa63b` was evaluated by CI
`34174762665` on September 8, 2026; the pull-request workflow checked out
synthetic merge SHA `5bfaf27dff7b936f25dbf24fb683ba58b48bed63`. It passed the
structural lockfile validation and reached browser bundle verification, proving
that the prior tarball identity failure was corrected. The main job then failed
because the bundle verifier treated Emscripten's literal `"file://"` protocol
test as a concrete package-manager path. The same run again passed
`browser-e2e` and all 15 `instrumented-resource-failures` cases; secret scan
`34174762663` passed. `compare` and `dispatch-builder` skipped downstream, while
the PR-only `fixed-commit-consumer` skip remained expected.

## Evidence required from the next final-head CI run

Run `34174762665` proves the following browser and resource properties while
evaluating PR head `61505a53f37a1daa652b63dbcc540a1d42bfa63b` through synthetic
merge SHA `5bfaf27dff7b936f25dbf24fb683ba58b48bed63`; the next run must
repeat them on the final bundle-verifier correction in one workflow run so
every required gate consumes that run's same synthetic merge SHA:

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
retirement evidence. The next main `ci`, `compare`, and `dispatch-builder` must
reach terminal success before making broader pipeline claims. The
`fixed-commit-consumer` job is expected to skip on a pull request because the
head commit is not yet reachable from `main`; it remains a post-merge/release
gate and must not be reported as PR-head evidence.

Heavy target-WASM, native-oracle, Chromium, and allocation-sweep execution stays
in CI. Local checks cover source preparation, contract tests, type checking, and
release-set validation only.

The provenance correction was checked locally on September 7, 2026:

- `pnpm test`: 102 passed and 58 artifact-dependent cases skipped;
- `pnpm run typecheck`: passed for both Node and web configurations;
- `pnpm run test:release-contract`: variant-generator and release-set contracts
  passed;
- `.trellis/scripts/task.py validate`: both task context files passed;
- a strict declaration-only worker/curated emit with `stripInternal` passed and
  retained the private `RemotePix` constructor and public read-only dimensions;
- `git diff --check`: passed.

These source-only checks do not replace the explicitly outstanding final-head
CI run. No local native, target-WASM, or Chromium build was performed.

On September 8, 2026, the consumer-gate correction added a pinned direct
`yaml@2.8.1` development dependency and replaced substring filtering with
fail-closed structural validation of pnpm lockfile version 9. The validator
binds the root importer, package key, resolution tarball, and snapshot key to
one exact tarball or Git identity. Tarball validation recomputes SHA-512 from
the actual candidate bytes and requires an exact SRI match. The parser rejects
aliases, duplicate keys, warnings, malformed YAML, and every explicit YAML tag;
the validator also rejects directory resolutions and any additional `file:`,
`link:`, or `workspace:` source. Filesystem containment uses canonical identities
so a symlink alias cannot escape or falsely trigger the consumer/worktree
boundary. A local integration test generates a real tarball and lockfile with
pnpm 10.34.5, while independent one-field mutations cover importer, package,
resolution, snapshot, extra-identity, malicious-key, and candidate-byte cases.

The follow-up bundle-verifier regression first reproduced CI `34174762665`'s
false positive, then replaced raw text matching with Vite's ESTree parser. The
gate is intentionally limited to actual `new URL(...)` resource references
through unshadowed `URL` and `self` globals; ordinary strings, diagnostics, and
protocol checks remain consumer-owned content rather than a general binding
policy. Every browser-base resource URL must resolve to that entry's expected
asset, and every unshadowed `Worker` constructor in `main.mjs` must use such a
URL directly, so an unused correct URL cannot hide an operational wrong sink.
Static resource values may use literals, templates, `+`, or lexically scoped
constants. Mutable calls such as `String.raw` and
`String.prototype.concat` are deliberately non-static, and direct writes to
the global `URL` or `Worker` constructor are rejected before resource
analysis. Temporal-dead-zone and shadowing checks prevent textual lookalikes
from satisfying the gate. Relative references are
resolved with the WHATWG URL algorithm and must reach the expected
same-directory asset; explicit schemes and authorities, including
protocol-relative and sentinel-origin inputs, and percent-encoded path
separators are rejected before filesystem resolution. URL preprocessing follows
browser semantics: ASCII tabs and newlines are removed, leading and trailing C0
controls or ASCII spaces are stripped, and non-ASCII whitespace such as NBSP
remains part of the path. The emitted curated and full-ABI WASM bytes must each
equal their corresponding installed package asset, closing the prior
path-without-identity gap. Independent cases cover disconnected URL decoys,
additional invalid resource URLs, direct constructor mutation, mutable
string-method composition, lexical shadowing, constant and class-heritage TDZ,
stringified fake URLs, encoded separator traversal, invalid authorities,
cross-variant references, and cross-variant bytes. A positive regression keeps
browser-valid leading and trailing ASCII URL whitespace accepted. This is a
generated-bundle integrity contract, not a claim that the static checker is a
JavaScript security sandbox against arbitrary hostile code.

The final concurrency audit also found a result-publication race at the generic
`WorkerSession` transport boundary. A transport may deliver a successful
response and a fatal response synchronously in one turn: the internal request
promise was already resolved, but its public continuation could previously
publish a new `RemotePix` or result after `markTerminated()` had retired the
session. A regression first reproduced the escaped live proxy. Successful
`init`, `load`, `run`, `extract`, and `query` continuations now re-check the
terminal gate before publishing any result; a companion case covers normal
`close()` starting in the same window. These source changes post-date CI
`34174762665`, so that run does not prove this additional invariant.

Final local source-only validation reports 146 tests passed
and 58 artifact-dependent tests skipped; the focused package, trap-retirement,
and instrumentation set reports 99/99. Node/web type checking, release-contract
tests, Trellis task validation,
and `git diff --check` also pass. CI `34188160101` then passed both real-browser
fatal-retirement cases, all 15 instrumented resource-failure cases, both WASM
variants, package tests, bundler checks, determinism, and release packing. Its
fresh-tarball consumer exposed one further verifier overconstraint: the bundled
main entry legitimately retains both the Worker URL and the curated WASM URL.
The corrected contract now requires that exact two-asset set for `main.mjs`,
keeps every Worker sink bound to `worker.mjs`, and still rejects every other
resource URL. The required release evidence is one replacement workflow run
with all downstream jobs succeeding on the same synthetic merge SHA.

## Final DBS cross-audit ruling

The September 8, 2026 Dijkstra, Popper, Parnas, and Gauss review round supplied
three concrete counterexample classes within this change's scope. Dijkstra
reproduced a same-turn success/fatal publication race; Popper showed that one
valid URL could hide an additional invalid resource URL; Parnas showed that a
disconnected valid URL could hide the URL actually passed to `Worker`. Gauss
reconfirmed those verifier failures and added mutable `URL`/string-built-in
counterexamples. Each in-scope counterexample now has a regression and a
bounded correction: result continuations re-check terminal state, every
browser-base resource reference is validated, every Worker sink must be
directly connected, mutable string methods are not folded as static resource
names, and direct global constructor writes are rejected.

The judge does not fold unrelated existing architecture or release governance
into this result. Worker binary-operation operand parity, exact export-target
mapping in the standalone package checker, fixed-commit dependency ordering for
external builder dispatch, and tag-to-main/same-SHA release authorization are
separate follow-up issues. They remain relevant before a broad release-ready
claim, but they neither invalidate the bounded fatal-retirement mechanism nor
become silently fixed by this work. No publish, commit, push, or main-branch
change is part of this evidence set.
