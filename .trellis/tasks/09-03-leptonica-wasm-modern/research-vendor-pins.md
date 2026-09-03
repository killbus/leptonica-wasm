# Research: vendor/versions.json pin 完整性核验

日期：2026-09-03。方法：GitHub REST API `/repos/{owner}/{repo}/commits/{ref}` 解析 tag→commit；emsdk 工具链逐字段与 pin commit 处源文件比对。结论：**全部 5 个依赖 pin 核验通过；libpng commit 已修正一处错值**。

## 1. 四个源码依赖（tag → commit）

| 依赖 | tag | commit（API 实测） | versions.json | 结果 |
|---|---|---|---|---|
| zlib | v1.3.2 | `da607da739fa6047df13e66a2af6b8bec7c2a498` | 同值 | ✅ |
| libpng | v1.6.58 | `3061454d980de7d53608f594194cfac722721d2a` | 原 `fdc7185d…` ❌ → 已改 | 🔧 修正 |
| libjpeg-turbo | 3.2.0 | `c85e6b905bf237038faa936dab160ebfc5da0344` | 同值 | ✅ |
| leptonica | 1.87.0 | `13275a278eb55b5746e33f95fbf5a2c8f604b3ab` | 同值 | ✅ |

- libpng v1.6.58 release 2026-04-15；leptonica 1.87.0 release 2025-12-24（API commit date）。
- libpng 原错值 `fdc7185dfedbddce8c2487bc171f66af4fca24ab` 来源不明（疑似手滑/幻觉），实测 v1.6.58 tag 指向 `3061454d…`。已改 `vendor/versions.json:18`。

## 2. emsdk（commit + sdkReleaseHash + 工具名）

pin：commit `5eb0bde7585670252e8ba05e9d361627bffd08b5`，"Release 6.0.9 (#1792)"，2026-09-01，GPG 签名 verified。

| 字段 | 值 | 核验方式 | 结果 |
|---|---|---|---|
| commit | `5eb0bde…` | API 直查（release commit，非 tag） | ✅ |
| sdkVersion | 6.0.9 | commit message "Release 6.0.9" | ✅ |
| sdkReleaseHash | `f04ea239d533260dd1db760dd2d668d5f9a88d6b` | release message 内嵌的 emscripten-releases revision；对 emsdk 仓库 API 422（确认非 emsdk commit，符合预期） | ✅ |
| cmakeTool | `cmake-4.2.0-rc3-64bit` | pin commit 处 `emsdk_manifest.json` tools 数组含 `cmake-4.2.0-rc3-64bit`（emsdk.py:931 注释亦引用） | ✅ |
| ninjaTool | `ninja-1.13.2-64bit` | 同 manifest 含 `ninja-1.13.2-64bit`（另有 `ninja-git-release-64bit` 源码构建项，不采用） | ✅ |

manifest 取样：`https://raw.githubusercontent.com/emscripten-core/emsdk/5eb0bde…/emsdk_manifest.json`（本地缓存 `tmp/research/emsdk-manifest-5eb0bde.json`）。工具全名构成：`id-version-bitness`。

## 3. emsdk 下载 URL 事实（供 build.mjs / workflow 用）

- SDK：`https://storage.googleapis.com/webassembly/emscripten-releases-builds/{os}/{rev}/wasm-binaries{suffix}.{ext}`（emsdk.py `emscripten_releases_download_url_template`，{rev} = sdkReleaseHash）。
- 工具（cmake/ninja）：`https://storage.googleapis.com/webassembly/emscripten-releases-builds/deps/`（emsdk.py `emsdk_packages_url`）。
- 结论：CI 用 `emsdk install`/`activate` 时以上 URL 由 emsdk 自理解，build 脚本无需硬编码。

## 4. 后续纪律

- 凡改 tag/commit：必须走本文件的 API 复核流程，不接受手填。
- CI 中 emsdk 相关 `uses:` action 的版本 pin 证据（release tag、URL、日期）写入 workflow 注释（execution-discipline 要求）。
