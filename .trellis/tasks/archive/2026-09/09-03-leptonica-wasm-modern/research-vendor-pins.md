# Vendor Pin Verification

## Source pins

The tracked source of truth is "vendor/versions.json".

| Dependency | Release | Commit |
| --- | --- | --- |
| zlib | v1.3.2 | da607da739fa6047df13e66a2af6b8bec7c2a498 |
| libpng | v1.6.58 | 3061454d980de7d53608f594194cfac722721d2a |
| libjpeg-turbo | 3.2.0 | c85e6b905bf237038faa936dab160ebfc5da0344 |
| Leptonica | 1.87.0 | 13275a278eb55b5746e33f95fbf5a2c8f604b3ab |

Each release label was resolved to the recorded commit. Build scripts fetch and check out the commit, not a floating tag.

## Toolchain pin

The current toolchain contract records:

- emsdk commit "5eb0bde7585670252e8ba05e9d361627bffd08b5";
- SDK version "6.0.9";
- CMake tool "cmake-4.2.0-rc3-64bit";
- Ninja tool "ninja-1.13.2-64bit";
- the exact downloaded archive name, URL, byte count, and SHA-256 for every toolchain component.

The emsdk installer does not provide the repository's required content-verification policy for every downloaded archive. "scripts/verify-toolchain.mjs" therefore checks the retained cold-install downloads against the tracked exact set.

## Verification boundary

- Cold installs set "EMSDK_KEEP_DOWNLOADS=1", install the pinned tools, and verify every retained archive.
- Verification rejects missing, extra, wrong-size, or wrong-hash archives.
- A successful cold install removes retained downloads before the toolchain cache is saved.
- Cache-hit jobs do not re-download or retain the large archive.
- The independent cold reproducibility job and comparison job verify that cached toolchain output matches a freshly verified build.

## Update procedure

For any emsdk commit, SDK, CMake, or Ninja change:

1. dispatch the "toolchain-hash" workflow in record mode for the intended pin set;
2. review the reported complete archive set;
3. update all toolchain fields and archive metadata in "vendor/versions.json";
4. open a reviewed change and run normal CI;
5. require exact-set verification and cross-job artifact equality.

Changing pins before recording the new archive set should produce a drift failure. That failure is the intended whitelist regeneration guard and must remain enabled.

## Trust root

Branch protection on "main" requires reviewed changes and blocks ordinary force pushes. It is the trust root for source pins, archive hashes, workflows, and release behavior.
