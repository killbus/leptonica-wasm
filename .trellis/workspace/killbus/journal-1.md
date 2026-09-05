# Journal - killbus (Part 1)

> AI development session journal
> Started: 2026-09-03

---

## 2026-09-03 M1 CI 首跑失败修复（TEAM C）

- CI run 33735115539 失败于 "Build (default, cold)"：`class_<PIX>` 编译错误——embind 的 `class_` 模板对 `typeid(Pix)`（wire.h LightTypeID）和 raw destructor（`delete ptr`）都要求完整类型，而 `allheaders.h` 只有 `struct Pix` 前向声明。
- 根因链：完整定义在 `pix_internal.h`（leptonica 内部头，自述 "can be #included after allheaders.h"，`bmf.c:74-75` 为官方组合先例）；该头不随 `make install` 安装。
- 修复：`cpp/bindings.cpp` 在 `allheaders.h` 后加 `#include "pix_internal.h"`；`build.mjs` emcc 参数补 `-I tmp/deps/leptonica/src`。
- Push 卫生：按用户指示（语义不变的实现修复），fixup 进 `12ce162` → autosquash rebase → `--force-with-lease` push 为 `599abcc`，不堆叠修复 commit。
- 本机 vitest 失败（node v24/win32，`Cannot read properties of undefined (reading 'config')`）经 stash 对照与 CI 日志对照确认是本地环境特有，CI（node 20/ubuntu）同 commit 测试绿——不阻塞，符合零编译纪律（运行时行为以 CI 为准）。
- 重跑：run 33743439895 已触发，监控中。
- run 33743439895 二次失败于链接：`emcc` 驱动 C 链接不含 libc++/libc++abi，`class_<PIX>` 的 typeid/RTTI 符号（`__cxxabiv1::__class_type_info`、`operator delete`）未定义。修复：`build.mjs` 链接器改 `em++`；顺带移除 `-sWASM_BIGINT=1`（emsdk 6.0.9 已废弃该开关，纯警告噪音）。
- 同样 fixup 进 M1 commit → `d824f30` force push → 第三次 run 33744418718 触发，监控中。
- run 33744418718 三次失败于 "Smoke test (default)"：断言 `symbol map should contain pixWriteMemPng` 红。构建本身全绿（双次构建 sha256 稳定 `f5b64575…`，PNG/JPEG/toRGBA 字节级断言全过）。
- 根因分析（读 emsdk pin 版源码 `emscripten-building.py:1162` 确认）：`--emit-symbol-map` 从最终 wasm 的 name section 读函数名；-O3 下 Binaryen 把单一调用点的 `pixWriteMemPng` 内联进 embind 包装，独立函数体被消除 → 名字合法消失。编码器在场已由字节级断言证明（PNG IHDR / JPEG SOI 逐项过），编码核心符号（`png_write_*` ×13、`jpeg_*` ×44）均在。
- 修复：断言收窄——`smoke.mjs` 删 `pixWriteMemPng` 名字在场断言（附注释说明内联成因），保留 load-bearing 的 `pixRead*` 缺席断言；`research-size-spike.md` §验证 同步记录该裁决与证据（run 号留档）。
- fixup → `483dbc5` force push → 第四次 run 33747019976 触发，监控中。
- run 33747019976 四次失败于 "Smoke test (full ABI)"：`full-abi wasm should export pixReadMemPng`。default 链路（双构建 + 冒烟）已全绿——只差 full-abi 冒烟。
- 根因（读 emsdk pin 版 `emscripten-link.py:1611-1636` 确认）：-O3 + JS 输出让 binaryen 启用 `MINIFY_WASM_IMPORTS_AND_EXPORTS`，wasm 导出名被压缩为 `da, ea, fa…`（2752 个导出、0 个 `pix*`，但 symbol map 3727 项里 `pixReadMemPng` 在 id 1723）。raw C ABI 逃生舱需要真名。
- 修复：`build.mjs` full-abi 分支加 `-sMINIFY_WASM_EXPORT_NAMES=0`（default 模式不加——embind 包装已吃掉导出面，体积优先；full-abi 才是 C ABI 消费者）。
- fixup → `18e0af9` force push → 第五次 run 33750787506 触发，监控中。
- run 33750787506 五次失败于 "Build (full ABI)"：`em++: error: MINIFY_WASM_EXPORT_NAMES is an internal setting and cannot be set from command line`——上一轮选的开关是内部设置，CLI 不可设。
- 重新分析（读 `emscripten-link.py` will_metadce + `emscripten-building.py:935` minify 函数）：导出名压缩的启用门是 metadce 链（`OPT>=3 或 SHRINK>=1` + 其余条件）且 `MINIFY_WASM_EXPORT_NAMES` 默认 1、无公开开关。唯一干净 CLI 杠杆是关掉 metadce——**full-abi 用 `-O2`**（OPT2/SHRINK0 → metadce 不跑 → 导出名保留）。代价：full-abi 体积测量从 -O3 降为 -O2，与 default(-O3) 的对照混入优化级别变量——已注释说明，M2 可用后链接重命名（symbol map 可逆映射） revisit。
- fixup → `ff86f5b` force push → 第六次 run 33754958056 触发，监控中。
- run 33754958056 六次失败于 "Smoke test (full ABI)"：`should not export pixReadMemWebP` 红——导出表里该名字**在场**。根因：leptonica `src/CMakeLists.txt` 用 `file(GLOB src "*.c")` 全量编译，`ENABLE_WEBP=OFF` 下 `webpio.c` 实现被 `HAVE_LIBWEBP` 守卫清空，但 `webpiostub.c` 提供同名错误桩（返回 NULL "function not present"）；gen-exports 的"声明 ∩ 归档定义"正确含入该桩。真实判据应为**解码器符号**（`WebP*`）缺席而非桩名缺席——实测 0 个。修 smoke 断言（default 模式断言不受影响：符号表 `pixRead*` 0 项，桩没被链进 default）。
- fixup → `343a6cd` force push → **第七次 run 33767637278 全绿**（全部 step 绿）。
- 数据回填：default 406KB/105KB gzip (93.8s cold)；full-abi 2.59MB/856KB gzip (2745 导出, 5.8s 复用依赖)；双构建 sha256 稳定 `f5b64575…`；冒烟全过。
- 裁决：**精选为默认产物、full-abi 逃生舱**（gzip 增量 ~750KB 远超 100KB 阈值）——回填 PRD 决策 ⑦ + research-size-spike.md 结果/结论 + implement.md M1 第 4/5/6 项勾选。M1 清单全部完成，进评审门。


## 2026-09-04 M1 评审门：两层评审、channel 基建故障与 monitor 纪律落地（TEAM C）

- 第一层 trellis-check（Agent 直派）：A–F 六项全 PASS、0 blocker/warning、3 nit（smoke 正则漏裸名、journal 856KB 时序残留、双次构建覆盖编译+链接层）；3 处文档级自修（implement.md/jsonl 的 emcc→em++ 陈述滞后、research 补 pix_internal.h/em++ 两条裁决使七次迭代单一文档可查）。独立核验超出评审包：default 符号表解码侧库符号 0 个（png_create_read_struct/jpeg_read_header 等）、编码侧在场——「仅写路径存活」在库级符号层成立。
- 第二层三视角（perf / supply / build-eng）原计划走 trellis channel spawn，**三个 worker 全部 spawn 即死**（`spawn claude ENOENT`）。根因：trellis 0.6.16 `resolveProviderPath` 只认 npm 格式 .cmd shim（正则匹配 `"%dp0%\...exe"`），本机 pnpm 安装的 claude.CMD 用 `%~dp0` + `IF EXIST` 结构不命中 → 裸 spawn("claude") → Windows 无 shell 不可执行 .cmd。上游 bug，无 provider 覆盖配置。绕行：Agent 工具直派三个独立评审员，评审实质不变；channel 失败证据留档 `~/.trellis/channels/.../review-m1/`。
- 监督失职教训：wait 虽写了 `--kind done,error` 但 fire-and-forget 未主动核查，worker 早死 25 分钟无察觉，靠用户发现。**用户指示：主 agent 对 worker 需补 monitor 职能** → 落地 `execution-discipline.md` 规则 4（派即监、早失败检测 spawn 后 2 分钟死亡高峰、timeout≠完成判据、失败处置留档）+ index.md 同步 + Common Mistakes 补「派后不监」条目。
- 供应链报告带 classifier 不可用核验提示，主会话抽查载荷性论断全部属实：分支保护 API 实测 enabled:false；pin commit 处 emsdk.py download_file 源码确认零 checksum 逻辑（CI 日志确认 298MB wasm-binaries.tar.xz 从 GCS 拉取）；leptonica tarball 实测 0 穿越。
- 评审员间事实矛盾裁决：build-eng N1 质疑 research 称 CMAKE_POLICY_VERSION_MINIMUM=3.5「关键」——实测四依赖树全部声明 ≥3.10（zlib 3.12...3.31 / libpng 3.14...4.2 / libjpeg-turbo 3.15...3.28 / leptonica 3.10），journal 七次迭代无 cmake policy 失败记录——build-eng 正确，research 已修正（预置防御 flag，M2 验证移除）。
- 判官汇总：0 blocker、8 warning（全部回填 M2 清单）、8 nit（豁免留档）。全场唯一实质新发现 supply W1：emsdk 工具链二进制（298MB wasm-binaries.tar.xz）无内容哈希校验，M2 sha256 白名单计划只覆盖依赖 tarball 漏了编译器本身。三视角独立收敛：裁决方向稳健（结构性下界 ≥2×，8x 为保守上界）；supply N3 与 build-eng W1 从不同路径撞上「M2 缓存分层必须带内容复验」。
- 用户过门确认（2026-09-04「推进」）→ 收口 commit `cd919c5` push。M1 关闭，进 M2。M2 新增高优先级项：.done 纳入 pin+flags 失效、npm ci --ignore-scripts 提前、开关名三分裂裁决、toGray 手算金样（先读 pin 版 pixConvertTo8 舍入行为）。


## Session 1: M1 评审门：两层评审、channel 基建故障与 monitor 纪律落地

**Date**: 2026-09-04
**Task**: M1 评审门：两层评审、channel 基建故障与 monitor 纪律落地
**Branch**: `main`

### Summary

(Add summary)

### Main Changes

(Add details)

### Git Commits

(No commits - planning session)

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete

## 2026-09-04 M4 native oracle harness (mid-flight check closed)

- src/protocol.ts Op tagged union + OP_DEPTH_RULES landed (shear.direction /
  rotate.quality / sobel.orientation strings + toGray.weights array — the
  field-name parsing in oracle.c mirrors this schema).
- cpp/oracle.c: parses the same op JSON, runs chains on native leptonica
  (same pins), emits golden PNG + scalar JSON. m4-check findings F1-F14 all
  cleared: 8/8/4-param fixes (otsu/sauvola/DWA), applyOp by-field parsing
  with per-op defaults, pixRotate (1bpp-capable) for rotate, center shears,
  L_BRING_IN_WHITE, ci comment accuracy, native deps cache layer, stale
  source rmSync parity.
- scripts/build-native.mjs + ci.yml native-oracle job (builds + uploads
  oracle binary artifact). First run caught a real compile error (pixBlend
  dest-arg misuse — pin signature is 5 params, no dest); fixed and amended.
- CI run 33917740452 all four jobs green (ci / reproducibility /
  native-oracle / compare) @ 9f3be74. oracle.c compile now CI-verified.
- Binary-op golden strategy (F5): same-image idempotence — harness runs
  both operands on the chain image; other handle id is read but unused.
  Recorded in code comments.

## 2026-09-04 M4 core layer CI red rounds closed (dc49240)

- Red round 1 (fe214b5): runChain wrapped raw PixHandle intermediates as
  Pix via lp.adopt(); core parity binary-op operands fixed (or/and/xor
  replayPrefix to 1bpp, blend passes 32bpp src) + idempotence invariant
  tests added; mutation-smoke anchor re-anchored to no-semicolon form.
  CI: only Consumer fixture step red.
- Root cause of red round 2: package.json exports pointed types at .ts
  sources — consumer tsc with skipLibCheck:false compiled package sources
  in the consumer program (TS5097 .ts imports, TS2614 ambient module
  outside program, TS2584 missing DOM). This was exactly the M3 review B1
  waiver condition: F16 consumer fixture turning hard gate.
- Fix (dc49240): scripts/gen-types.mjs three-step d.ts emission to
  dist/types (tsc emitDeclarationOnly via paths shim → specifier rewrite
  to relative form → plain-module twin of the ambient glue +
  emscripten-glue-shape.d.ts copy). exports types → dist/types/*.d.ts,
  import stays ./src/*.ts (source-direct runtime model). Caught pre-commit:
  import conditions had wrongly pointed at dist artifacts (leptonica.mjs
  is the Emscripten factory without named exports — runtime import would
  break); corrected to src before commit.
- CI run 33928265707 all five checks green (ci / compare / gitleaks /
  native-oracle / reproducibility). Consumer fixture step now runs
  gen-types then tsc + attw (esm-only profile; node10/CJS waived per
  ADR 1). M4 implement.md checklist fully checked.

## 2026-09-05 M4 review fix round closed (uncommitted at write time)

- M4 two-layer review verdict was hold: 2 blocker (binary-op other silently
  dropped; Node entry import pointed at .ts) + judge-escalated warnings
  (extraction leak, degenerate deskew anchors). Fix round landed all
  three batches in one working-tree change set (cpp / TS / entry).
- cpp batch: copyToJs() frees the C-side toPNG/toJPEG/toRGBA buffers
  (was +68MB/60 extractions); slant fixture (−0.04 rad) + two golden
  chains so deskew actually rotates (conf 3.486, residual −0.22°);
  mutation-smoke rotates 3 sites (threshold/otsu/rotate).
- TS batch: operand table gives or/and/xor/blend their real second
  operand; close() poisons the arena; run() re-checks source; finite
  param validation; it.each parity; degrees documented; depth-rule
  matrix; the N3 FinalizationRegistry test found a REAL dev-mode bug
  (register(pix, pix, pix) throws when target===holdings) — fixed with
  { pix } holdings objects.
- entry batch: gen-types emits JS now; exports import points at
  dist/types/*.js; consumer check RUNS main.ts (16×16 real chain);
  check-exports --curated-methods guards the hand-pinned interface
  (34 methods), wired as a CI step.
- W13 waived in writing with corrected reasoning: the otsu mirror is
  deliberate (real wrapper drags the decode cluster past the
  check-exports gate); upstream drift protection comes from the
  exact-commit pin, NOT from the goldens (both sides carry the same
  mirror — recorded after the trellis-check re-review corrected my
  first draft of the rationale).
- Local verification: typecheck both domains, 84/84 tests, 3-site
  mutation smoke, curated-methods check, consumer check incl. node run.
  Stale local goldens (missing the 2 slant chains) are filtered to
  chains-with-goldens; CI regenerates all and pins the count.
- trellis-check re-review (m4-refix-check channel): all fixable
  findings verified fixed, no scope creep, regression sweep clean.
  CI evidence to be appended after push; M4 gate awaits user go-ahead
  for M5.

## 2026-09-05 M4 fix round: two CI red rounds closed

- Red round 1 (run 33933970780, 88fd3a7): consumer fixture died on
  `ERR_UNKNOWN_FILE_EXTENSION` — `node main.ts` only works where the
  runtime strips TS types (local Node 24 does; CI Node 20 does not).
  The fixture exists precisely to catch "typecheck green ≠ runtime entry
  green", and local verification missed it because of the local Node 24
  trap. Fix: compile main.ts to dist/ (same strict flags as tsconfig,
  --ignoreConfig to dodge the noEmit/include conflict) then run
  node dist/main.js. Lesson: verifying a .ts entry by direct node run
  proves nothing about CI's runtime — compile the way CI does.
- Red round 2 (run 33934231026, 19b2d62): compare job failed on ONE
  byte in 630955 — libjpeg-turbo's BUILD string defaults to the
  configure date (CMake string(TIMESTAMP %Y%m%d), embedded in
  jcmaster.c's jpeg_version). ci job linked cached .a files configured
  Sep 4 UTC; reproducibility job cold-compiled fresh .a on Sep 5 UTC;
  the midnight boundary put "20260904" vs "20260905" into otherwise
  byte-identical wasms. Fix: pass -DBUILD=<pin tag> (3.2.0) so the
  string derives from the pin; deps cache key and .done marker both
  invalidate on the flag change. Run 33934560265 green across all four
  jobs, compare reports 4 artifacts byte-identical, artifact carries
  "build 3.2.0". Lesson: wall-clock inputs hide in dependency configure
  scripts — the compare job is what makes them visible; one-byte diffs
  with same file size smell like embedded version/date strings, and
  cmp -l pinpoints them in seconds.

## 2026-09-05 M5 fix round + pnpm migration

- M5 review (reviews/M5.md) found two blockers, both confirmed with
  zero false positives: B1 design promised session.terminate() but
  only @internal markTerminated() existed; B2 the esbuild fixture
  shipped a bundle whose worker would 404 the wasm at runtime
  (build-only false green — exactly the minefield the matrix exists
  to catch). Fix round ac7ab20 + d848790: public terminate(),
  uniform async poisoning (five query methods), worker default
  branch + single-shot init gate, esbuild wasm copy + output-layout
  assertion in check-bundler-matrix (negative-validated: removing
  the wasm turns the assertion red).
- Layout assertion negative validation had a trap: the full check
  re-runs the esbuild fixture which re-copies the wasm, so the
  "delete then check" probe must assert ONLY the layout logic against
  the moved-wasm state. Lesson: when a fixture's check step repairs
  the state under test, negative validation needs the assertion in
  isolation.
- pnpm migration (490bef7, user direction "pnpm instead of npm"):
  supersedes M0 F11 "main package stays npm". packageManager pin
  pnpm@10.34.5 — pnpm 11 needs Node >=22.13 (node:sqlite) and dies on
  the Node 20 CI runner. Traps hit: (1) corepack resolves the pin
  from the NEAREST package.json — the fixtures workspace and consumer
  fixture each need their own packageManager pin or a stray pnpm 11
  runs there; (2) a pnpm 11 run rewrote pnpm-workspace.yaml with an
  invalid allowBuilds placeholder that pnpm 10 then treated as fatal;
  (3) pnpm refuses non-TTY node_modules purges without CI=true.
  Local + CI verification: 95/95, typecheck, consumer check, bundler
  matrix, runs 33942042722 and 33942410612 green.

## 2026-09-05 M6: E2E + release, two-layer review

- M6 landed on m5-worker-session (PR #4): Playwright E2E (browser vs
  Node byte-identical PNG through the same session API), LICENSE
  (BSD-2-Clause, dual copyright), README (three quick-starts + API
  tables), dist sha256 manifest (39 entries incl. full-abi), and a
  tag-triggered release workflow publishing via pnpm (user direction
  2026-09-05).
- Four CI red rounds, all closed: package-name import in the E2E spec
  (no self-link in-repo), dist-relative import failing pre-build
  typecheck (fixed with src import - the worker.test.ts pattern), a
  fat-fingered upload-artifact pin, and a manifest generation step I
  wired into release.yml but forgot in ci.yml. Lesson pair: E2E specs
  that typecheck in the repo's own tsconfig cannot import the package
  name (no self-dependency) nor dist (built after typecheck); and any
  script referenced by two workflows must be wired into both.
- The big catch of the review layer: a reordering commit dropped the
  corepack/pnpm install step from release.yml entirely - invisible to
  CI because release.yml only triggers on tags, and no tag can exist
  before branch protection lands. Layer-1 trellis-check caught it.
  Lesson: workflow files not exercised by push-triggered CI need a
  structural review pass (step inventory vs requirements) regardless
  of green runs elsewhere.
- Adjudication trap worth remembering: M2 F2 said "pack excludes
  full-abi" but M3 had RE-ADJUDICATED it (no-decode is a
  default-artifact promise, not a package-scope promise - full-abi IS
  the shipped escape hatch, PRD decision 7). I implemented the stale
  M2 reading and had to correct it (bd7b018). When implementing an
  older finding, always check for later re-adjudications in the
  review chain first.
- Review record: reviews/M6.md. Gate 3 technically met at cb510a7
  (CI 33944836717); user-side preconditions pending: branch
  protection (M2 F1), NPM_TOKEN secret, then merge PR #4 and tag
  v0.1.0 for the first real publish.

## 2026-09-05 M6 release-channel change + workflow syntax red

- User direction: npm publishing DISABLED, GitHub Release is the only
  distribution channel. Rewrote the release workflow tail: pnpm
  publish + NPM_TOKEN fail-loud removed, replaced with
  softprops/action-gh-release (v3.0.3, commit-pin efb3536, research
  trail in the workflow comments) attaching the pack-reviewed tarball
  as the release asset; permissions contents:read → contents:write;
  registry-url dropped from setup-node. NPM_TOKEN prerequisite is
  void — the release preconditions drop from three to two (branch
  protection remains). README provenance + implement.md + reviews/M6
  adjudication record updated (2f3d856).
- Red round I caused myself: the first version of the rewrite wrote
  the new step as "- name:" followed by "- uses:" at a deeper indent —
  a malformed step block. GitHub could not parse the file: it created
  a zero-job failure run on every BRANCH push (33947511782, invalid
  file = trigger filter unevaluable = runs on all pushes). Fix
  9da8e12 (single well-formed step). Proof of recovery: the fix push
  produced NO release.yml run on the branch push (tag filter now
  readable), while the same push's ci + secret-scan went green
  (33947729263 / 33947729178). Lesson: this repo has NO local YAML
  parser (no yaml pkg, no ruby/python-yaml) — a hand-rolled
  indentation check of step items caught it only after the red run;
  for tag-only workflows, an invalid file announces itself as
  zero-job failure runs on ordinary branch pushes, not as a silent
  skip. Watch for that signature.

## 2026-09-05 v0.1.0 released (GitHub Release)

- Branch protection landed (main protected:true). PR #4 merged
  (0edbed3) with all checks green; main CI green (33949334034).
- First v0.1.0 tag push: release run 33949512439 FAILED at Pack
  review with a false negative — tar | grep -qx under
  set -euo pipefail kills tar with SIGPIPE when grep exits on
  first match; pipefail then marks the pipeline failed even though
  the file IS in the tarball. Verified by local reproduction.
  Fix (PR #5, c7960c9): read the full listing into a variable,
  then grep the variable — no pipe, no SIGPIPE.
- Re-tagged v0.1.0 on c7960c9: release run 33949945440 GREEN.
  GitHub Release v0.1.0 is live with leptonica-wasm-0.1.0.tgz
  (1.26 MB) attached; artifact downloaded and verified — full-abi
  six files + dist/sha256.json + LICENSE + README all present.
- The npm-publish-disabled posture had its first real end-to-end
  execution: cold verified toolchain, build, test, pack review,
  GitHub Release creation. M6 review W3 (release-tail zero
  execution history) is closed with a green production run.

## 2026-09-05 v0.1.1 (README fix reaches the tarball)

- User caught it: the README's three code blocks were fenced with
  literal escaped backticks (backslash-backtick x3) — GitHub
  rendered zero code highlighting; the raw escape sequences showed
  as plain text. Root cause: shell-escaping accident when the
  README was first written (172c44b); every render check since had
  been on the SOURCE, not the RENDERED output. Fixed all six fence
  lines (PR #7, 2b6db4b).
- The v0.1.0 tarball predates the fix — its bundled README was
  still broken. Version-bumped to 0.1.1 (PR #8), tagged v0.1.1 on
  the merge commit (ec65629), release run 33950744417 green.
- Verified the published artifact: downloaded the v0.1.1 tarball,
  extracted package/README.md — 6 proper fence lines, zero escaped
  backticks, version field 0.1.1. v0.1.1 is the Latest release.
- Lesson: README fences written via shell heredoc/echo must be
  byte-checked (od -c) not just visually catted — the escaped form
  looks almost right in terminal output. And a docs fix that lands
  after a tag does not reach that tag's tarball: bump + re-tag is
  the only way the shipped artifact gets it.
