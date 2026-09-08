# Build and CI Execution Discipline

This specification defines the durable build, automation, release, and agent-execution contracts for this repository.

## 1. Heavy work runs in GitHub CI

### Contract

- Local work is limited to editing, source inspection, text/header parsing, unit tests, type checks, and other lightweight validation.
- Do not install or run emsdk, compiler suites, native dependency builds, or WebAssembly compilation locally unless the user explicitly approves it.
- GitHub CI owns compilation, reproducibility checks, native-oracle builds, release builds, and platform-specific execution.
- A local test result never substitutes for a required CI build result.

### Validation

| Situation | Required action |
| --- | --- |
| Source or workflow behavior changes | Push the implementation commit and monitor the relevant CI runs. |
| Documentation-only tracked text changes | Run text and format checks; CI monitoring is not required unless a workflow contract is affected. |
| CI fails | Read the failing job and logs, fix the root cause, update the logical commit when history is private, and monitor the replacement run. |
| A local rebuild appears convenient | Keep the build in CI and add focused diagnostics there. |

## 2. Research and pin every GitHub Action

### Contract

Before adding or changing a workflow "uses:" entry:

1. identify the official repository and documentation;
2. inspect the latest applicable release and its publication date;
3. confirm the documented inputs and permissions;
4. resolve the release tag to an immutable commit SHA;
5. record the release tag, date, source URL, and commit pin in a nearby workflow comment or task research note.

Use immutable commit pins. Do not use floating branches or unverified major-version aliases.

## 3. Repository path ownership

| Path | Purpose |
| --- | --- |
| "tmp/deps/" | Runtime-fetched dependency sources. |
| "tmp/emsdk/" | Runtime-fetched toolchain checkout. |
| "tmp/" | Other disposable build and packaging state. |
| "third_party/" | Read-only reference material managed by a manifest. |
| "dist/" | Generated distributable artifacts. |
| "build/" | Tracked release-contract tooling only. |

Do not place fetched dependencies under "build/" and do not introduce a second temporary root. The tracked "build/" exception contains reviewable source scripts and tests; it is not a generated build directory.

## 4. Agent goal initialization, retry, and monitoring

### Standard initialization

Every dispatched agent must call the platform's standard `create_goal` mechanism as its first action, before any task work. The agent-owned goal must include the business objective and this explicit instruction:

> Treat stream disconnections, HTTP 429 responses, and transient HTTP 5xx network or service failures as retryable. Retry automatically with backoff and continue; do not terminate or request user intervention solely because of these errors.

When the parent thread has an active goal, dispatch without forking its context unless the platform proves goal state is isolated. Pass the exact assignment and necessary context explicitly. An inherited parent goal is not an agent-owned goal.

The dispatch prompt must require this first action, but the prompt itself, implicit inheritance, and later messages do not substitute for a successfully created goal. Until successful goal creation is confirmed, the instance is not started. If `create_goal` fails or returns `GOAL_MISSING`, stop and close it without task work; do not wait for, resume, or send task input to it, and create a replacement. Once a goal is active, preserve and resume that same instance across retryable transport or service failures.

### Main-agent monitor role

The main agent remains responsible for dispatched work:

- confirm that the agent-owned goal became active;
- subscribe to success and error terminal events;
- check progress during the early failure window and at planned intervals;
- distinguish a timeout from completion;
- inspect raw status or event history when progress is unclear;
- resume the same active agent after transient transport or service failures, with backoff;
- record non-retryable failures and choose an in-scope recovery path;
- review returned work before accepting it.

If the agent cannot call the standard goal mechanism, continue in the main agent instead of treating the dispatch as valid.

## 5. Pull-request and history discipline

### Contract

- A small pull request represents one logical change and is merged with squash semantics.
- Prepare a private branch as coherent review history by folding correction commits with fixup and autosquash rebase.
- Execute a squash merge only after the final target-branch subject and body are explicit and reviewed. When GitHub CLI performs the merge, provide that reviewed metadata explicitly.
- Treat squash as the target-branch integration method, not as a substitute for correcting misleading or sensitive branch history while rewriting remains safe.
- Preserve merge commits only when the branch structure itself carries useful reviewed history.
- Before rewriting a published ref, create explicit local backup refs and use "--force-with-lease" against the verified remote state.

### Required checks

- Inspect the commit graph before and after merge or rewrite.
- Confirm the target branch contains one intended logical commit for a squash merge.
- Audit every remote branch and tag when the requirement applies to reachable history, not only to "main".

## 6. Safe shell and GitHub CLI usage

### Contract

- Put multiline pull-request or release text in a file and pass it with a file option.
- Avoid shell interpolation for text containing backticks, dollar signs, or command examples.
- Never expose credentials through arguments, URLs, environment dumps, logs, or tracked files.
- Git and GitHub authentication uses the approved stdin credential-helper flow. Secret values remain outside agent context.
- Verify exact destructive targets before deleting or replacing refs.

## 7. Supply-chain trust root and toolchain verification

### Source pins

"vendor/versions.json" is the single source of truth for dependency commits, emsdk revision, SDK version, auxiliary tool names, archive URLs, byte counts, and SHA-256 values.

### Toolchain update order

For any change to the emsdk commit, SDK version, CMake tool, or Ninja tool:

1. dispatch the "toolchain-hash" workflow in record mode against the intended toolchain;
2. review the reported archive names, byte counts, and SHA-256 values;
3. update "vendor/versions.json" with the complete verified set;
4. run normal CI and allow the drift check to enforce exact set equality.

A drift failure is the intended regeneration guard. Do not bypass, disable, or relax it.

### Cache boundary

- Toolchain archive hashes are verified on the cold-install path while retained download archives are available.
- Do not add archive re-verification to a cache-hit path: retaining the large download archive in the cache defeats the cache design.
- Cached toolchain content is revalidated by the independent comparison job and exact pinned inputs.
- Dependency cache markers include source pins and build flags so configuration changes invalidate the cache.

### Trust root

Branch protection on "main" anchors release provenance. Keep branch deletion and non-fast-forward updates blocked so published source history cannot be removed or rewritten.

## 8. Package and release channel

- Use pnpm for installation, tests, packing, and scripts. npm commands are outside the supported workflow.
- Registry publication is disabled.
- GitHub Release is the sole publication channel.
- Release artifacts are built in CI from the pinned, cold-verified toolchain.
- The package includes the curated default artifacts, the full-ABI escape hatch, type declarations, license, README, and the content hash manifest required by the release workflow.
- Git-source package preparation derives its commit from intrinsic source metadata: a Git checkout uses its exact HEAD, while a commit archive uses a tracked export-substituted marker. An expected commit supplied by CI only cross-checks that intrinsic identity and never replaces it.
- Commit archives record source-tree dirtiness as unobservable rather than clean. The fixed-commit consumer checks the exact Git specifier, the codeload URL containing the requested commit SHA, and the resulting package provenance; the Git lock entry does not provide an independent archive-content hash.
- A documentation correction made after a tag requires a new version and tag to reach a published tarball.

## 9. Stable product-specific constraints

- The grayscale oracle uses the intentional perceptual weights "0.3f / 0.5f / 0.2f". Do not replace them with an unrelated standard coefficient set.
- The default artifact exposes the curated write-oriented surface; the full-ABI artifact is the explicit compatibility escape hatch.
- Release variants are source-owned private configuration. Builder-facing payloads contain only the versioned public manifest, exact source revision, immutable release ID, and opaque target identities.

## 10. Verification checklist

Before completing build or release work, confirm:

- applicable tests and type checks pass;
- workflow actions are researched and commit-pinned;
- no heavy local build occurred;
- cache keys and markers cover changed pins and flags;
- cold-install verification remains on the cold path;
- the comparison job still validates reproducible outputs;
- pnpm is used throughout;
- registry publication remains absent;
- GitHub Release inputs and permissions are minimal;
- dispatched agents, if any, created their own standard goals as their first action and were actively monitored;
- commit and merge topology matches the intended history.
