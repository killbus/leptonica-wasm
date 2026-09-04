# leptonica-wasm 实施计划

上游：`prd.md`（需求与决策）、`design.md`（架构与 ADR）。按里程碑顺序执行；每个里程碑独立可验收，落地时执行「评审规程」（双层 chatroom review，见下）；三个评审门（M1 / M4 / M6 后）在 findings 清零后需用户确认再继续。

## 评审规程（Reviewer SOP）

每个里程碑落地（清单完成 + 验证命令通过）后执行双层评审；不可跳过、不可合并。

1. **触发**：该里程碑全部条目完成且「验证」行命令通过
2. **评审包**：变更文件清单、验证命令输出、与计划的偏差说明（含需回填 PRD/design 的裁决项）
3. **第一层·硬评审**：dispatch `trellis-check` 子代理——对照 `check.jsonl` manifest 三件套核验规格符合性与测试证据；小问题就地自修并报告，重大问题列 findings
4. **第二层·多视角评审**：dbs-chatroom 专家团（评审包 + 第一层报告为输入）按下表视角并行独立评审 → 判官汇总结论与分歧 → findings（blocker / warning / nit）
5. **修复轮**：blocker 必修；warning 需书面豁免理由；nit 记 backlog。改动代码 → 重跑验证命令 + trellis-check 复核
6. **记录**：两层评审与处置写入任务目录 `reviews/M{N}.md`（评审包摘要、check 报告要点、各视角发言摘录、判官总结、findings 处置表）
7. **过门**：非门里程碑 findings 清零即继续；评审门里程碑（M1/M4/M6）另需用户确认

### 各里程碑 chatroom 视角

| 里程碑 | 评审视角（人格由主持方直接选定，无需用户逐次确认——2026-09-03 用户指示） |
| --- | --- |
| M0 | 工程卫生、供应链意识（ignore/exclude 边界） |
| M1 | 二进制体积与性能、供应链安全（pin 完整性）、构建工程 |
| M2 | CI 可复现性、导出面安全（无解码入口）、缓存有效性 |
| M3 | API 设计（DX）、危险边界文档、类型松紧权衡 |
| M4 | 测试有效性（oracle 公正性、红→绿纪律）、API 一致性 |
| M5 | 并发与生命周期（毒化/terminate）、跨 bundler 兼容 |
| M6 | 发布工程（provenance、产物审查）、文档 DX |

纪律：第一层先跑（小问题修完再进第二层）；chatroom 分歧未收敛记 open question——不阻塞非门里程碑，但必须在下一评审门前裁决。

## M0 仓库初始化

- [x] `.gitignore` 配置（`node_modules/`、`build/`、`dist/`、`third_party/*` 不 track + `!third_party/manifest.json` 例外；`git init` 用户已完成）；本地凭据排除走 `.git/info/exclude`（已配置，凭据文件名不进任何 tracked 文件，规则见 AGENTS.md）
- [x] `package.json`（ESM-only、`type: module`）+ `tsconfig.json` + vitest 配置
- [x] npm 包名查重（`leptonica-wasm` 可用，无需回写 design.md §2）
- 评审：双层评审 + 修复轮 + 复核 8/8 通过（reviews/M0.md）；首次 commit 含 Trellis/agent 配置目录（用户 2026-09-03 指示）
- 验证：`npm test`（空测试）通过；`npx tsc --noEmit` 通过
- 回滚点：纯脚手架，删文件即回滚

## M1 体积 spike ★评审门 1

执行纪律（2026-09-03 用户指示，详见 `.trellis/spec/build-ci/execution-discipline.md`）：本机零重任务——一切编译在 GitHub Actions 执行，依赖源码 fetch 落 `tmp/deps/`，本机仅编辑、头文件解析与 npm test/typecheck 级验证。

- [x] `scripts/build.mjs` 最小可跑：`vendor/versions.json` pin 四依赖（zlib/libpng/libjpeg-turbo/leptonica 精确 commit）→ fetch（`tmp/deps/`）→ emcmake → ninja → em++ 出 wasm（脚本在 CI 内执行，本机只验语法）——242 行，`node --check` 通过；default/full-abi 双模式 + build-report.json（wasm raw/gzip 体积、sha256、耗时）
- [x] `cpp/bindings.cpp` 最小 embind：`fromRGBA` / `toGray` / `toPNG` / `toJPEG` / `toRGBA` 五函数跑通——79 行已写；冒烟脚本 `scripts/smoke.mjs`（132 行）在 CI 内验证运行时行为（PNG IHDR 断言 / JPEG SOI / toRGBA 字节往返 / 负向用例）
- [x] `.github/workflows/size-spike.yml`（M1 构建执行地）：逐 action 研究后引用（最新 release + 文档，证据留注释）→ emsdk 按 pin 安装 → 双次从零构建产物哈希一致性 → Node 冒烟 + `pixRead*` 缺席验证 → 全量对照构建 → 体积（raw+gzip）/耗时采集 → step summary + artifact 上传——97 行 workflow_dispatch 触发；checkout/setup-node/upload-artifact 三 action 全 pin（证据注释内含 release tag/日期/链接）
- [x] 测量：产物体积（raw + gzip）、冷构建耗时基线（供 CI 缓存与超时配置）；导出表/符号表确认无解码入口（`pixRead*` 缺席验证）——CI run 33767637278 全绿：default 406KB/105KB gzip、full-abi 2.59MB/855KB gzip；双次构建 sha256 稳定；冷构建 93.8s；符号表 `pixRead*` 0 项、full-abi 无真实 `WebP*` 解码符号
- [x] 对照构建：`gen-exports.mjs` 首版扫 `allheaders.h` → 全量 C ABI 导出再测体积——2745 函数（声明 ∩ 归档定义），full-abi 模式体积见上
- [x] 产出 `research-size-spike.md`（原计划名 `research/size-spike.md`，随实际扁平落盘同步；design §8 四项裁决建议；CI 数据回填后收口）——结果/结论已回填：裁决"精选为默认、full-abi 逃生舱"（gzip 增量 ~750KB 远超 100KB 阈值）；含 7 次 CI 迭代的裁决记录（embind 完整类型、em++ 链接、-O3 内联与导出名压缩、WebP 错误桩）
- 验证：CI workflow 内从零连续两次构建产物一致；Node 脚本 load wasm 跑通 fromRGBA→toGray→toPNG（本机仅静态验证，运行时验证由 CI 承担）；`npm test` + `npx tsc --noEmit` 保持绿
- 评审门：体积数据回填 PRD 决策 ⑦（core/full 与 raw 层默认产物裁决），用户确认后进 M2
- 回滚点：spike 结论不满足预期 → 回 design §3 重新裁决，不动后续里程碑

## M2 构建管线正式化

- [x] `build.mjs` 完整化：开关名裁决统一（现 `--full-abi` vs 本清单旧称 `--raw-abi` vs design §3 `/full` 子导出——三分裂，评审 build-eng 议题）→ 2026-09-04 裁定 `--full-abi` CLI / `dist/full-abi/` 产物 / `src/raw/` TS 层（design §2 已同步）；依赖 fetch 缓存、`--emit-tsd` 接入；**前置修复**：`.done` 编译标记纳入 pin commit + flags + **工具链 commit** 哈希失效（M1 评审 build-eng W1 + design §3 工具链键要求；emsdk bump 后未变 pin 不得复用旧 emcc 编译的 .a）——commit 069e8df + 本批 `--opt` 扩展；curl 下载原子性（.part + rename，build-eng N2）；build-report 增 `jsGzipBytes` + provenance 字段（sdkVersion/四依赖 pin/优化级别，perf F3 + build-eng N4；`--opt` 后报告 optimizationLevel 跟随实际值）；`CMAKE_POLICY_VERSION_MINIMUM=3.5` 移除验证（build-eng N1：四依赖全部声明 ≥3.10，flag 必要性未复现）——commit d81795b，**run 33899237236 验证通过**（缓存键轮换触发四依赖冷配置，零 policy 错误，三 job 全绿 + reproducibility 侧白名单 4/4 再验）；full-abi 默认 outdir 改 `dist/full-abi/` 防覆盖（build-eng N2）
- [x] `scripts/check-exports.mjs`：d.ts 符号 vs `WebAssembly.Module.exports` diff（**按模式分层定义比较对象**——full-abi 比 d.ts↔wasm exports，default 比 d.ts EmbindModule↔模块实例方法，build-eng 议题 4）；**库级解码符号缺席断言自动化**：png_create_read_struct / png_read_* / jpeg_read_header / jpeg_start_decompress / inflateInit_* = 0 + 正则 `\w*` 收紧（perf F2/F5——现 CI 断言一弱一空：漏裸名 pixRead；default 模式 metadce 压缩导出名使 `/^pix(Read|Write)/` 检查结构性空转；强证据仅一次性人工核验不在 CI）——commit 809215d，四路变异测试全红（注入 jpeg_read_header/裸 pixRead/伪 d.ts 符号/伪 EmbindModule 方法均被抓获），CI run 33835338376 双模式通过
- [x] GitHub Actions PR CI：pin emsdk（**改从 versions.json 读取注入，消除 yml 硬编码双写**——M1 评审 build-eng W2：现 yml 注释宣称来源 versions.json 但实际硬编码，versions.json emsdk 节零消费者）→ wasm 构建 + **default@-O2 同优化级别对照**（perf 议题 1：复用依赖仅 ~6s，澄清 -O2/-O3 混合对照的精确数字；build.mjs 新增 `--opt` 开关支撑，与 `--full-abi` 冲突时拒绝）+ 原生构建（cmake+ninja，同 versions.json pin；**推迟至 M4 落地**——2026-09-04 裁定：native 构建产物唯一消费者是 M4 oracle harness，M2 阶段无消费者，孤立构建只预热无人读取的缓存；M4 清单第 1 项已含"CI 原生构建复用 versions.json 全部 pin"）→ check-exports → node test；缓存分层（emsdk 按版本键、deps 源码+静态库按 versions.json+工具链哈希键 + **flags 哈希**（build-eng 议题 1：只键 pin 不键 flags 会在"缓存恢复+调 flags"下产生 stale build；实现为 `hashFiles('scripts/build.mjs')` 过似——depConfigs 定义在 build.mjs 内，任何 flags 变更必然改文件；`.done` 标记同时纳入工具链 commit）+ **restore 后内容复验**（supply N3：缓存键非内容寻址，缓存层是绕过 fetch 校验的旁路；实现为 compare job——ci job 暖缓存产物 vs reproducibility job 独立冷构建产物的四文件 sha256 全等），design §3 构建分发策略）；确定性比对扩面（.mjs/.d.ts/.symbols 哈希 + 跨 runner，supply W3/build-eng W3；同 runner relink 比对 + 跨 job 冷构建比对两级）；runner pin `ubuntu-24.04`（supply N4）；`npm ci --ignore-scripts` 已核实安全（lockfile 唯一 hasInstallScript 是 fsevents，darwin-only Linux 跳过；vitest 工具链走预构建 rolldown napi binding 无 postinstall 依赖）——commit 1f10e84 + 缓存键逗号修复 78138ef（run 33844970673 失败：deps_hash 逗号 join 触发 actions/cache "Key Validation Error"，改 sha256 前 16 hex；emsdk 键无逗号故过、reproducibility 无缓存故绿——三 job 结论差异即定位证据）；**run 33855910354 全绿**：ci 16 步含双模式 check-exports/smoke/同 runner 四产物复现、reproducibility 独立冷构建、compare 跨 runner 四产物字节一致；default@-O2 对照实测（perf 议题 1 闭环）：-O3 406460/107969 gzip vs -O2 408681/105210 gzip——-O2 raw 略大而 gzip 略小，M1 的 -O2(full-abi) vs -O3(default) 混合对照自此有了同优化级别基线
- [x] 供应链防线（M0 评审回填 + M1 评审扩展）：CI 默认 `npm ci --ignore-scripts`（supply N1，M1 已落地）；secret 模式扫描（**已落地** supply N5：`.github/workflows/secret-scan.yml` gitleaks-action v3.0.0 commit-pin + GITLEAKS_VERSION=8.30.1 可复现扫描 + fetch-depth 0 覆盖历史 + 每日 04:07 UTC cron；首跑 run 33872339633 绿，12s）；依赖升级自动化（**已落地**：`.github/dependabot.yml`——github-actions ecosystem 显式（supply W2a）+ npm dev-deps 分组；落地当天即出首个 github_actions 更新（run 33872348143）与 npm 分组 PR；npm 走 `--ignore-scripts` CI 姿态验证过）；**sha256 白名单扩展覆盖工具链**（**已落地** supply W1：emsdk.py `download_file` 无哈希校验 + manifest sha 字段全空已源码级实证（research-vendor-pins.md §3.1）——`vendor/versions.json` `emsdk.toolchainArchives` 四归档 file/url/bytes/sha256（记录自 run 33870871356，字节数与 33855910354 独立下载交叉吻合）+ `scripts/verify-toolchain.mjs`（默认哈希比对 / `--record` 再生成模式）+ `.github/workflows/toolchain-hash.yml`（workflow_dispatch 记录载体）+ ci.yml 两条冷装路径接线（`EMSDK_KEEP_DOWNLOADS=1` → install → verify → ci 分支 `rm -rf downloads` 后入缓存层；验证失败 job 红 → actions/cache post `success()` 门挡住毒化归档进缓存）——run 33884503228 全绿（reproducibility 冷装 4/4 哈希通过），run 33899237236 再验 4/4；commits 11eed10 + 6d474f7 + 05e1e40）；**白名单再生成纪律**（**已落地** supply 议题 1：emsdk bump → dispatch toolchain-hash → record 输出粘进 versions.json → PR review；归档文件名随 pin 变化，`verify-toolchain.mjs` 强制 downloads 与白名单集合相等，漏记响亮失败——research-vendor-pins.md §4.1）；**分支保护**（**待用户操作** supply W3：禁 force push、versions.json/workflow 变更走 PR review——与白名单信任根同批，`gh api` 需用户授权或用户在 GitHub 设置页操作）
- [x] toGray 手算金样（P2 末位，M4 oracle 前的像素值级补丁）：现有冒烟对 toGray 只验灰度 PNG 头（位深/颜色类型），像素值从未断言——M2 恰好要动构建（`.done` 修复、default@-O2 对照、CMAKE_POLICY flag 移除），是引入回归的时机而现有断言抓不住。**前置条件已履行**：读 pin 版（13275a27）源码确认 `pixConvertTo8(32bpp)` → `pixConvertRGBToLuminance` → `pixConvertRGBToGray(0,0,0)` → 默认权重是 pix.h **感知权重 0.3f/0.5f/0.2f 而非 BT.601**（本清单原假设 0.299/0.587/0.114 是错的——前置条件防住的正是这个）；逐像素 `(l_int32)(f32 积和 + 0.5)`，C 晋升链：积与加为 float32、末项 +0.5 是 double、截断。断言围绕实现确切行为：smoke.mjs 增 2×2 锚点（纯 R/G/B 三基色钉死三权重——BT.601 会给 green 150/blue 29 vs 实际 128/51；漏 +0.5 会给 green 127/red 76）+ 独立 `grayAnchor()` JS 重实现（Math.fround 严格镜像 C 晋升边界，判别矩阵已实测）+ `decodeGrayPNG()` 完整五滤波灰度 PNG 解码器（libpng 逐行选滤波不能假设 filter 0；Sub+Paeth 路径已合成 PNG 往返验证）。M4 oracle harness 进来后被吸收
- 验证：干净 checkout 一条命令出 `dist/`；CI 全绿；连续两次运行第二次命中缓存——**全部达成**（07a0064 空 commit 复跑 run 33864372196：emsdk 509MB / deps 43MB 双命中 + 三 job 绿；后续实现变更 run 33884503228 / 33899237236 亦全绿，白名单与 flag 移除各有冷装验证证据）
- 回滚点：`git revert` 构建脚本提交

## M3 raw 层

- [ ] `gen-exports.mjs` 完整化：`EXPORTED_FUNCTIONS` + `_malloc/_free` + 松 d.ts
- [ ] `src/raw/`：C ABI 松类型包装 + 危险区文档（无所有权语义声明）
- [ ] tsconfig 拆 base/node/web 三域（web 域 lib 含 DOM/WebAssembly、node 域注入 @types/node——首个 TS 文件触及 WebAssembly 前完成，M0 评审 F3：WebAssembly TS2304 已实测复现）；`exports`/`files`/`sideEffects` 骨架随首个 src 文件原子落地（M0 评审 F1）
- 验证：Node 冒烟单测（`_pixCreate` 可调，malloc/free 往返）；check-exports 全量符号通过
- 回滚点：独立目录，可整体不发布（`exports` 移除子路径即可）

## M4 精选层同步核心 ★评审门 2

- [ ] native oracle harness（C 程序）：解析与 `protocol.ts` 同构的 Op JSON + 输入图 → 跑同一批算子链 → 产出金样（PNG/标量）；CI 原生构建复用 versions.json 全部 pin
- [ ] **测试先行**：每算子先写含 oracle 金样断言的测试并确认失败（红）→ 再写 `cpp/bindings.cpp` embind 实现（按 design §4.2 映射表逐函数对 `allheaders.h` 核实选型，含 `pixGetRGBAPixels` 存在性、translate 组合方案）→ 变绿；红→绿提交历史可查
- [ ] `src/protocol.ts`：`Op` tagged union 完整版（harness 与 TS 端共用 schema）
- [ ] `src/core/`：TS 包装（Pix `Symbol.dispose` + 毒化 + FinalizationRegistry 报警、chain builder、查询、提取、depth 校验规则）
- [ ] 补充不变量单测：deskew 角度恢复、otsu 双峰、dilate 单调、**1bpp depth 保持**、类型规则 throw、毒化行为
- [ ] d.ts 消费者视角验证（M0 评审 F16）：consumer fixture 以 skipLibCheck:false 编译 + arethetypeswrong
- 验证：vitest 全绿 + oracle 比对全绿（PNG 逐字节、标量容差）；**变异冒烟**——故意破坏一个参数映射 → 测试必须红，恢复 → 绿；`--emit-tsd` 生成 d.ts 且 check-exports 通过
- 评审门：API 面走查（对照 PRD 8 类算子清单逐项确认）+ 抽查红→绿提交历史，用户确认后进 M5
- 回滚点：逐算子独立提交，revert 单算子不动全局

## M5 Worker 会话客户端

- [ ] `src/worker/`：会话客户端（句柄代理、chain 录制）、worker 入口（wasm 定位 + `wasmPath` 覆盖）、Node `worker_threads` 适配、`close()` 毒化 + `terminate()`
- [ ] Worker 单测（Node worker_threads）：协议往返、transfer、close 毒化、terminate 无残留、run() 失败路径中间 Pix 清理
- [ ] 跨 bundler 冒烟：vite / webpack5 / esbuild / Node ESM 构建最小示例并加载 worker（CI matrix）
- [ ] `prepublishOnly`（typecheck + test + build 串行，M0 评审 F9）
- 验证：vitest worker 套件全绿；四 bundler 冒烟通过
- 回滚点：会话层独立于核心——最坏降级为仅同步层发布（包 `exports` 移除 `./worker`）

## M6 E2E 与发布 ★评审门 3

- [ ] Playwright E2E：浏览器 vite 页 → `createSession` → 链执行 → PNG 字节 vs Node 输出**逐字节比对**（环境一致性；语义正确性已在 M4 oracle 锚定）
- [ ] README：三段式快速开始（Worker 主入口 / 同步核心 / raw 逃生舱）+ API 表
- [ ] release workflow（tag 触发）：build → test → `npm publish --provenance`——CI 是发布产物唯一来源，本地构建不发布（design §3）
- [ ] npm publish `--dry-run` + `npm pack` 内容审查（发布前预检）
- [ ] LICENSE 文件（BSD-2-Clause + Leptonica 版权归并，M0 评审 F13）
- [ ] wasm 产物 sha256 清单随包发布；CI 复现构建 digest 比对（npm integrity 不证明 wasm↔C 源码对应——M0 评审 F7）
- 验证：`playwright test` 绿；`npm publish --dry-run` 无 error；dist 内容与 exports 映射一致
- 评审门：发布前最终确认（用户执行实际 publish 或授权执行）
- 回滚点：发布前一切可撤（dry-run 为门）；发布后 deprecate / next tag

## PRD 验收对照

| PRD 验收项 | 里程碑 |
| --- | --- |
| 从零干净环境一条命令可复现构建 | M2 |
| Node 全链 toGray→otsu→dilate→toPNG，1bpp 语义保持 | M4 单测 |
| Playwright E2E 字节级一致 | M6 |
| oracle 比对（wasm vs 原生同 pin 构建，含变异冒烟） | M4 |
| session.close() 毒化 + terminate 无残留 | M5 单测 |
| d.ts 与实际导出 CI diff | M2 |
| 体积 spike 报告回填 core/full 裁决 | M1 |
| npm dry-run + 双端 smoke | M6 |
