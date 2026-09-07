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

## Evidence required from the next CI run

The browser fatal-retirement claim still requires a single new commit SHA whose
`browser-e2e` job actually executes, without skips, against the generated
target-WASM artifact and proves all of the following:

- a real `__builtin_trap()` rejects both concurrent pending requests within the
  timeout;
- the production browser adapter invokes physical Worker teardown exactly once;
- a later client call is rejected without dispatching into the retired Worker;
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
