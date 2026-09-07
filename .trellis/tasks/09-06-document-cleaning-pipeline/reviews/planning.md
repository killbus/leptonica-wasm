# Planning review - version 1

> Superseded in part by [boundary review version 2](boundary-review.md).
> The approval record remains historical; documentClean-specific contracts
> below are no longer authoritative.

Date: 2026-09-06. Status: approved by the user in the subsequent message
`批准`; implementation is authorized.
Baseline: `00594e6bd7418f7b571307e9da2ebb065beb12c1`.
Branch: `feat/document-cleaning-pipeline`.

## Proposed decision

- Deliver safe documentClean and curated bindings, main/worker lifecycle
  parity, two independent package consumers, resource gates, and the
  real-scan production-decision report. Extend existing ownership.
- Preserve legacy Sauvola output; add tiled Sauvola for the new pipeline.
  Default to a compact mask and four-connected area > 3 filtering.
  Color retention and shared-geometry deskew remain opt-in.
- Verify every package export, strict consumer declarations, both worker
  runtimes, and the exact release candidate installed from a tarball.
  Separately install a reachable fixed GitHub source commit with pnpm.
- The Git source route requires the pinned toolchain and explicit pnpm
  dependency-script approval. Only the prebuilt tarball route promises
  compiler-free installation. Builds and heavy validation run in CI.
- Require native-allocation cleanup, failure injection, 20 warm-up pages
  followed by at least 100 measured pages, and the reviewed secondary
  memory budgets. Compare six JS/WASM paths on authorized real scans;
  report quality, cold/first/steady timing, memory, and package sizes.
- Exclude pdfhow production changes, first-version dewarp, npm publication,
  toolchain upgrades, builder changes, and unapproved scan uploads.
  Ordinary PR integration remains subject to the relevant authority.

The authoritative requirements, defaults, and milestones are
[prd.md](../prd.md), [design.md](../design.md), and
[implement.md](../implement.md). Conditional go is not production approval.

## Planning validation

- Re-read the fixed pdfhow handoff and checked receiving-source evidence.
- Completed the PRD convergence pass: all nine requirement IDs/priorities
  and all six acceptance mappings were preserved. Clarified the existing
  design's distinction between recoverable failures and fatal WASM traps.
- `python3 .trellis/scripts/task.py validate
  .trellis/tasks/09-06-document-cleaning-pipeline` passed: five implementation
  context entries and four review context entries resolve.
- A read-only Node assertion pass checked task JSON/JSONL, local Markdown
  links, final newlines, whitespace, conflict markers, and 29 current PRD
  file/line anchors. It also checked requirement/acceptance preservation,
  feature-branch identity, and the planning-only change boundary.
- `git diff --check` passed. Untracked documents were checked separately;
  a clean tracked diff alone would not validate them.
- No product files were edited or staged. Task status remains planning,
  and `implementation_approved` remains false. No build, install, runtime
  test, benchmark, agent dispatch, commit, push, release, or PR was performed.

The first anchor check failed on a blank-line reference. Inspection found
four approximate references worth correcting; the current PRD and research
note now point to the relevant source lines. Historical anchors are retained
here only as an audit trail, not as current evidence:

| Earlier anchor | Current anchor | Reason |
| --- | --- | --- |
| `src/worker/worker.ts:97` | `src/worker/worker.ts:98` | Arena adoption starts after the blank line. |
| `scripts/gen-types.mjs:213` | `scripts/gen-types.mjs:220` | Point directly to worker-wrapper generation. |
| `scripts/build.mjs:79` | `scripts/build.mjs:82` | Point to the actual libjpeg SIMD setting. |
| `.trellis/spec/build-ci/execution-discipline.md:139` | `.trellis/spec/build-ci/execution-discipline.md:133` | Point to the GitHub Release-only distribution contract. |

## Approval and remaining prerequisites

The user approved planning summary version 1 on 2026-09-06 in the subsequent
message `批准`. The receiving branch and `origin/main` were both rechecked at
`00594e6bd7418f7b571307e9da2ebb065beb12c1`, so no synchronization change was
needed before activation. Material design changes require renewed review.

Authorized real scans and their permitted storage/execution locations remain
an external prerequisite for the comparison report, not a reason to replace
that acceptance criterion with synthetic tests. No runtime, package, resource,
or production-readiness gate has passed during this planning turn.
