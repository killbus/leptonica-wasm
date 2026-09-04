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

### 3.1 工具链归档无内容校验（supply W1 实证）

对 pin commit `5eb0bde…` 处 emsdk.py 逐行核实：

- `download_file`（701-730 行）：下载后**无任何哈希校验**，TLS 是唯一通道保护。
- 默认 install 后删除归档（2160-2165 行）；`EMSDK_KEEP_DOWNLOADS=1` 保留（且已存在文件跳过重下载，708-710 行）。
- `emsdk_manifest.json` 工具条目 `archive_url=(none)`、`sha=(NONE)`——manifest 本身不携带哈希。
- 实测下载清单（CI run 33855910354 日志，linux 排除 python 与 manifest `deps_linux` 一致）：`node-v24.19.0-linux-x64.tar.xz` 31.6MB（storage.googleapis.com/.../deps/）、`f04ea239…-wasm-binaries.tar.xz` 298.5MB（.../linux/f04ea239…/）、`cmake-4.2.0-rc3-linux-x86_64.tar.gz` 58.2MB（Kitware GitHub releases）、`ninja-1.13.2-linux-x64.zip` 134KB（.../deps/）。约 430MB。
- `sdkReleaseHash` 是 GCS 路径 revision 寻址，**不是字节哈希**。

### 3.2 防线缺口分析

- ci 与 reproducibility 从同一 GCS 来源冷装——来源被毒化时两边产物一致，compare 绿灯：被篡改的编译器可以完全确定性（Thompson 1974），现有确定性检查对此盲。
- M6 npm provenance 只证“包来自此 repo+workflow”，不证“编译器是上游声称的那个”。
- 残余风险接受边界：TLS + Google 托管 + manifest 被 git commit 钉住，真实威胁只剩 emscripten 发布基础设施被接管（Codecov/SolarWinds 同型）；TOFU 局限——哈希记录自今日下载，记录前已毒化则钉的是毒，与所有 pin 同型，最终信任根是 review-gated 的 git 历史（分支保护 W3）。

## 4. 后续纪律

### 4.1 工具链 sha256 白名单（supply W1 落地，2026-09-04）

三件套：

1. `vendor/versions.json` `emsdk.toolchainArchives`：file/url/bytes/sha256 白名单。**url 仅文档用途**（再生成时从 install 日志 `Downloading:` 行解析），验证只比对 file/bytes/sha256。
2. `scripts/verify-toolchain.mjs`：默认模式哈希比对（读 `tmp/emsdk/downloads/`，失败退出 1）；`--record` 模式输出 JSON 块（`--log` 时从日志解析 url + 交叉核对字节数）。
3. `.github/workflows/toolchain-hash.yml`（workflow_dispatch）：冷装 pin 工具链 + `--record`，哈希落 git 历史而非仅 CI 日志。ci.yml 接线：两条冷装路径（ci cache-miss 分支 + reproducibility 恒冷装）设 `EMSDK_KEEP_DOWNLOADS=1` → install → verify → （ci 分支）`rm -rf tmp/emsdk/downloads` 后才入缓存层。验证失败 job 红 → actions/cache `post-if: success()` 不保存 → 毒化归档进不了缓存。

**再生成纪律**（supply 议题 1 的工具链面）：

- emsdk bump（commit/sdkVersion/cmakeTool/ninjaTool 任一变化）→ dispatch toolchain-hash → 把 record 输出粘进 versions.json → PR review。归档文件名随 pin 变化，`verify-toolchain.mjs` 强制 downloads 与白名单集合相等，漏记会响亮失败而非静默验证旧列表。
- 信任模型 TOFU：recorded 哈希的可信度 = 那次下载的可信度；最终权威是 review-gated git 历史（分支保护 W3，与白名单同批落地）。
- 不做：验证整个 emsdk 树（只验 4 个归档）；从源码重建工具链；给 deps tarball 钉字节哈希（codeload 无契约，走 §4 API 复核纪律路线）。
- 凡改 tag/commit：必须走本文件的 API 复核流程，不接受手填。
- CI 中 emsdk 相关 `uses:` action 的版本 pin 证据（release tag、URL、日期）写入 workflow 注释（execution-discipline 要求）。
