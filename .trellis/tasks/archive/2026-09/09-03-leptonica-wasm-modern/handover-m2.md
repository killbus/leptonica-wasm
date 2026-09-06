# M2 Review Handover

## State

All six M2 work items and the two-layer review are complete. Actionable findings are closed; branch protection was carried as a release prerequisite and later enabled before release.

## Evidence

- Export and mutation checks: run 33835338376.
- Full CI, independent cold build, and cross-job comparison: run 33855910354.
- Toolchain and dependency cache-hit validation: run 33864372196.
- Toolchain archive whitelist validation: runs 33884503228 and 33899237236.
- The comparison job proved byte-identical curated artifacts across warm and cold paths.

## Stable constraints

- Verify retained toolchain archives only on the cold-install path. Do not retain the large archive merely to hash it on a cache hit.
- The independent comparison job validates cached toolchain output.
- Before changing any emsdk pin, run the record-mode toolchain-hash workflow, then update "vendor/versions.json". Exact-set drift failures are the intended guard.
- Keep the grayscale anchor at "0.3f / 0.5f / 0.2f" with pinned rounding behavior.
- Use pnpm and keep registry publication disabled.
- Monitor implementation pushes immediately; documentation-only pushes do not require CI monitoring unless they alter a workflow contract.

## Next milestone

M3 implements the full-ABI loader, package exports, loose declarations, and danger boundary.
