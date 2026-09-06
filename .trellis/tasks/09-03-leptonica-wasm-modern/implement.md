# Leptonica WebAssembly Implementation Plan

The authoritative requirements are in "prd.md" and architecture is in "design.md". Milestones are independently reviewable. M1, M4, and M6 are user-confirmed review gates.

## Reviewer SOP

After a milestone checklist and its verification line pass:

1. Prepare the changed-file list, verification evidence, and design deviations.
2. Run "trellis-check" first against "check.jsonl".
3. Fix small confirmed issues before the perspective review.
4. Run the milestone perspectives independently through the approved review mechanism.
5. Adjudicate disagreements and record blocker, warning, and nit dispositions.
6. Fix blockers; document any warning waiver; keep nits only when they are explicit backlog.
7. Re-run affected checks and review the fix round.
8. Record the result in "reviews/MN.md".
9. Continue automatically after findings are cleared for a non-gate milestone. Request user confirmation after M1, M4, or M6.

Every dispatched reviewer must receive standard goal initialization with the repository retry contract, and the main agent must actively monitor progress and terminal events.

| Milestone | Review perspectives |
| --- | --- |
| M0 | Repository hygiene and supply-chain boundaries |
| M1 | Binary size/performance, pin integrity, build engineering |
| M2 | CI reproducibility, export-surface safety, cache validity |
| M3 | API developer experience, danger documentation, type tradeoffs |
| M4 | Test effectiveness, oracle independence, API consistency |
| M5 | Concurrency/lifecycle and bundler compatibility |
| M6 | Release provenance, end-to-end consistency, documentation DX |
| M7 | Source/builder ownership, public schema minimization, retry behavior |

## M0. Repository initialization

- [x] Configure tracked ignores and local-only exclusions.
- [x] Create the ESM package, TypeScript domains, and Vitest setup.
- [x] Establish pinned pnpm package management.
- [x] Complete the two-layer review and fixes.

Verification: package scripts and TypeScript configuration load successfully.

## M1. Size spike — gate 1

- [x] Build pinned zlib, libpng, libjpeg-turbo, and Leptonica in CI.
- [x] Implement minimal Embind input, grayscale, PNG/JPEG, and RGBA paths.
- [x] Compare curated and full-ABI artifacts.
- [x] Verify deterministic output and curated decode-symbol absence.
- [x] Record size and timing evidence in "research-size-spike.md".
- [x] Select curated default plus full-ABI escape hatch.

Evidence: CI run 33767637278; curated wasm approximately 406 KB raw and 105 KB gzip; full ABI approximately 2.59 MB raw and 855 KB gzip.

## M2. Formal build pipeline

- [x] Finalize build modes, output directories, reports, atomic downloads, and cache invalidation inputs.
- [x] Verify declarations against actual exports and enforce curated decode-symbol absence.
- [x] Add pinned PR CI, independent cold reproducibility, cross-job comparison, and cache-hit evidence.
- [x] Add secret scanning, dependency automation, archive whitelist verification, and record-mode hash workflow.
- [x] Add a discriminating grayscale anchor using "0.3f / 0.5f / 0.2f".
- [x] Complete the two-layer review and finding dispositions.

Evidence: runs 33835338376, 33855910354, 33864372196, 33884503228, and 33899237236. Toolchain and dependency caches both hit on the validation rerun.

## M3. Full-ABI layer

- [x] Generate verified exports and loose declarations.
- [x] Add the raw loader, dynamic memory view, allocator access, and danger documentation.
- [x] Split Node and web TypeScript domains.
- [x] Add package exports for the full-ABI artifacts.
- [x] Complete review fixes for test ordering, pointer-to-pointer usage, wasm export paths, and type-boundary follow-up.

Evidence: CI runs 33913374420 and 33914534570.

## M4. Curated synchronous core — gate 2

- [x] Build a native oracle from the same source pins in CI.
- [x] Define the shared operation protocol.
- [x] Implement curated operators with depth rules, disposal, poisoning, and extraction cleanup.
- [x] Add independent goldens, scalar tolerances, and mutation checks.
- [x] Add strict downstream declaration and runtime consumer fixtures.
- [x] Resolve binary-operand, runtime-entry, finalizer, deskew, and deterministic dependency-build findings.

Evidence: CI runs 33917740452, 33928265707, and 33934560265.

## M5. Worker session client

- [x] Implement browser and Node session clients with chain recording.
- [x] Implement arena cleanup, close poisoning, public terminate, and in-flight rejection.
- [x] Verify worker asset layout under Vite, webpack, esbuild, and Node ESM.
- [x] Migrate all package operations and fixtures to pinned pnpm.

Evidence: CI runs 33942042722 and 33942410612; 95 tests passed.

## M6. End-to-end and release — gate 3

- [x] Compare browser worker and Node output bytes with Playwright.
- [x] Publish README, license, package exports, and artifact SHA-256 manifest.
- [x] Review pnpm package contents before release.
- [x] Use a tag-triggered, cold-verified GitHub Release workflow.
- [x] Keep registry publication disabled.
- [x] Enable branch protection as the whitelist trust root.
- [x] Complete releases v0.1.0 and v0.1.1; v0.1.1 contains the corrected README fences.

Evidence: main CI run 33949334034; release runs 33949945440 and 33950744417.

## M7. Source-owned release variants

- [x] Add strict private "variants/*.json" definitions and generated compile-time locks.
- [x] Add private variant selection to the build while keeping public provenance opaque.
- [x] Fail closed before Embind registration for a locked browser hostname mismatch.
- [x] Add canonical release-set and target identities from the exact source revision.
- [x] Dispatch the public manifest after source CI reproducibility passes.
- [x] Retry stream disconnections, HTTP 429, and transient HTTP 5xx failures with backoff.
- [x] Document the source-owned dispatch settings and delegate builder-owned provisioning to the builder guide.
- [x] Add regression tests for gate, validation, payload minimization, retry classification, and non-retryable failures.

Verification: "pnpm run test:release-contract", "pnpm test", "pnpm run typecheck", and "git diff --check".

## Acceptance mapping

| Requirement | Evidence milestone |
| --- | --- |
| Clean reproducible build | M2 |
| Curated chain and 1bpp semantics | M4 |
| Browser/Node byte consistency | M6 |
| Independent native oracle and mutation proof | M4 |
| Session close and terminate lifecycle | M5 |
| Declaration/export consistency | M2-M4 |
| Curated/full-ABI size decision | M1 |
| Reviewed pnpm package and GitHub Release | M6 |
| Opaque source-owned release variants | M7 |
