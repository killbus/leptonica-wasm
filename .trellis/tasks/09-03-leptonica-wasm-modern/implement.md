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

- [ ] `scripts/build.mjs` 最小可跑：`vendor/versions.json` pin 四依赖（zlib/libpng/libjpeg-turbo/leptonica 精确 commit）→ fetch → emcmake → ninja → emcc 出 wasm
- [ ] `cpp/bindings.cpp` 最小 embind：`fromRGBA` / `toGray` / `toPNG` / `toJPEG` / `toRGBA` 五函数跑通
- [ ] 测量：产物体积（raw + gzip）、冷构建耗时基线（供 CI 缓存与超时配置）；导出表/符号表确认无解码入口（`pixRead*` 缺席验证）
- [ ] 对照构建：`gen-exports.mjs` 首版扫 `allheaders.h` → 全量 C ABI 导出再测体积
- [ ] 产出 `research/size-spike.md`（design §8 四项裁决建议）
- 验证：脚本从零目录连续两次构建成功且产物一致；Node 脚本 load wasm 跑通 fromRGBA→toGray→toPNG
- 评审门：体积数据回填 PRD 决策 ⑦（core/full 与 raw 层默认产物裁决），用户确认后进 M2
- 回滚点：spike 结论不满足预期 → 回 design §3 重新裁决，不动后续里程碑

## M2 构建管线正式化

- [ ] `build.mjs` 完整化：`--raw-abi` 开关（或按 M1 裁决定产物形态）、依赖 fetch 缓存、`--emit-tsd` 接入
- [ ] `scripts/check-exports.mjs`：d.ts 符号 vs `WebAssembly.Module.exports` diff
- [ ] GitHub Actions PR CI：pin emsdk → wasm 构建 + 原生构建（cmake+ninja，同 versions.json pin）→ check-exports → node test；缓存分层（emsdk 按版本键、deps 源码+静态库按 versions.json+工具链哈希键，design §3 构建分发策略）
- [ ] 供应链防线（M0 评审回填）：CI 默认 `npm ci --ignore-scripts`；committed pre-commit 通用 secret 模式扫描（gitleaks 类，不点名任何文件）；依赖升级自动化（dependabot/renovate 分组小步，盯 TS 7.x 补丁链）
- 验证：干净 checkout 一条命令出 `dist/`；CI 全绿；连续两次运行第二次命中缓存
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
