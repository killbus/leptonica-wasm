# Journal — killbus, Part 1

Started: 2026-09-03

## 2026-09-03 to 2026-09-04 — M1 size spike

- The curated and full-ABI builds were established in CI from exact source and toolchain pins.
- Embind required the complete Pix definition and a final "em++" link.
- Optimized symbol behavior required assertions based on callable surfaces, functional bytes, and real codec-library symbols rather than one expected standalone function name.
- The full ABI required an optimization posture that preserved exported names.
- CI run 33767637278 passed. Curated wasm measured about 406 KB raw and 105 KB gzip; full ABI measured about 2.59 MB raw and 855 KB gzip.
- The product decision became curated-by-default with a full-ABI escape hatch.

## 2026-09-04 — M1 review and execution discipline

- The review identified toolchain archives as a supply-chain input requiring an exact content whitelist.
- Cache markers needed source pins, toolchain identity, and build flags.
- Native-oracle compilation was assigned to M4, its first consumer.
- Agent execution gained a durable monitor role: initialize every dispatch through the standard goal mechanism with retry behavior, inspect early failures and terminal events, and treat timeout as an observation rather than completion.

## 2026-09-04 — M2 formal build pipeline

- Build modes, output directories, reports, atomic downloads, and cache invalidation were finalized.
- Curated methods and full-ABI exports gained mode-specific checks plus mutation probes.
- PR CI gained pinned runners, independent cold reproducibility, and cross-job byte comparison.
- Toolchain cold installs retain and hash the complete archive set, then remove downloads before caching.
- Cache-hit jobs intentionally do not retain the large archive; the independent comparison job validates their output.
- The grayscale anchor was confirmed against the pinned implementation at "0.3f / 0.5f / 0.2f" with its exact rounding behavior.
- Runs 33855910354, 33864372196, 33884503228, and 33899237236 closed the build, cache, and archive-verification evidence.

## 2026-09-04 — M3 full-ABI layer

- The generated declaration-and-definition intersection became the callable full ABI.
- The raw loader documents pointer width, ownership, C strings, cross-instance pointers, and pointer-to-pointer outputs.
- CI ordering was corrected so raw tests cannot silently skip their required artifact.
- Package exports include the full-ABI JavaScript, wasm, and declaration paths.
- Runs 33913374420 and 33914534570 passed.

## 2026-09-04 to 2026-09-05 — M4 curated core

- A native Leptonica oracle, shared operation protocol, curated synchronous API, lifetime poisoning, depth rules, and mutation checks were implemented.
- Review fixes ensured binary operations use the real second operand, extraction buffers are freed, deskew fixtures are discriminating, and FinalizationRegistry holdings are separate records.
- Generated runtime JavaScript and declarations moved to distributable paths and are exercised by a strict consumer.
- A one-byte reproducibility difference exposed a configure-date string in a dependency; pinning the build string removed wall-clock input.
- Runs 33917740452, 33928265707, and 33934560265 passed.

## 2026-09-05 — M5 worker session and pnpm

- Browser and Node worker sessions gained arena cleanup, close poisoning, public terminate, and consistent in-flight rejection.
- Vite, webpack, esbuild, and Node ESM fixtures verify worker and wasm output layout.
- Package operations and nested fixtures migrated to pinned pnpm compatible with the Node 20 CI runtime.
- Runs 33942042722 and 33942410612 passed with 95 tests.

## 2026-09-05 — M6 end-to-end and release

- Playwright verified browser worker output against the Node path byte for byte.
- Package exports, license, README, full-ABI files, and a SHA-256 manifest became release requirements.
- The release workflow uses a cold verified toolchain and creates a GitHub Release containing the pnpm tarball.
- Registry publication was removed from the product contract.
- Branch protection became the whitelist trust root.
- A package-listing check was made robust under "pipefail" by reading the complete listing before matching paths.
- Version 0.1.1 delivered corrected README code fences. Main CI run 33949334034 and release runs 33949945440 and 33950744417 passed.

## 2026-09-06 — M7 source-owned release variants

- Strict private variant definitions, compile-time lock generation, and fail-closed browser hostname checks were added.
- Release-set tooling reads the exact source revision, derives canonical opaque target and release identities, verifies requested identities, and invokes the private selector internally.
- The public payload is limited to contract version, source revision, release ID, and canonical public manifest.
- The source repository documents only its route and dispatch credential names. The builder owns its full environment, secrets, transport, candidate lifecycle, and provisioning guide.
- Dispatch retries stream disconnections, HTTP 429, and transient HTTP 5xx failures with backoff; other HTTP failures stop with diagnostics.
- Release-contract tests, unit tests, and type checks passed for commit a9fe40f.

## Durable lessons

- Keep heavy compilation in CI and local work lightweight.
- Research and commit-pin every workflow action.
- Run the toolchain-hash record workflow before changing emsdk pins; exact-set drift is a guard, not an obstacle.
- Keep cold archive verification on the cold path and validate cache hits through independent output comparison.
- Use pnpm and GitHub Release only.
- Fold private-branch corrections into the logical commit and use squash semantics for small pull requests.
- Verify rendered documentation and packaged artifacts, not only source text.
- Describe repository contracts in international English with clear ownership and without unrelated project identities.
