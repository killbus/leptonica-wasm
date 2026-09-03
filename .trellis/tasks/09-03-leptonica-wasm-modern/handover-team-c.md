# 交接：leptonica-wasm-modern — M1 尾段接管

> 产自主会话（M1 实现 + commit + push 完成后）。收件方：TEAM C。

## 仓库与任务状态

- **任务路径**：`.trellis/tasks/09-03-leptonica-wasm-modern`（Trellis 管理）
- **仓库**：`github.com/killbus/leptonica-wasm`，`main @ 12ce162`（已 push，upstream 跟踪已设；两个 commit：bootstrap `3ee66a6` + M1 spike `12ce162`）
- **恢复上下文**：跑 `trellis-start`（新会话）或 `trellis-continue`（续接）；按序读 `implement.jsonl` → `prd.md` → `design.md` → `implement.md`

## 已完成（勿重做）

- 依赖 pin 全部经 GitHub API 验证（`research-vendor-pins.md`）
- M1 六产物已交付且本地静态验证全绿（`node --check` ×3 / `npm test` 1/1 / `tsc --noEmit`）：
  - `scripts/build.mjs`（default/full-abi 双模式 + build-report.json）
  - `scripts/gen-exports.mjs`（2743 函数导出表）
  - `scripts/smoke.mjs`（PNG/JPEG/toRGBA 往返 + 负向断言）
  - `cpp/bindings.cpp`（embind 五函数）
  - `.github/workflows/size-spike.yml`（CI，见下）
  - `research-size-spike.md`（骨架，待回填）
- `implement.md` M1 前三项已勾；**第 4/5/6 项（测量/对照构建/报告收口）待 CI 后勾**

## 待办（严格按序）

1. **触发 CI**：`gh workflow run size-spike.yml --ref main`（或 UI workflow_dispatch）；跑满约 60 分钟（双次从零构建哈希一致性 + full-abi 对照 + 冒烟）
2. CI 成功 → 回填 `research-size-spike.md` 的结果/结论占位（数据源：run 的 step summary + `dist` artifact 内 `build-report.json`）；同步勾掉 implement.md M1 第 4/5/6 项
3. 回填 PRD **决策 ⑦**（core/full 默认产物裁决，依据 spike 数据）
4. **M1 评审门**（详见 `implement.md` "Reviewer SOP"）：
   - dispatch `trellis-check` 子代理（prompt 以 `Active task: .trellis/tasks/09-03-leptonica-wasm-modern` 开头）
   - dbs-chatroom 三视角：二进制体积与性能 / 供应链安全(pin 完整性) / 构建工程
   - findings 清零 → 记 `reviews/M1.md`
5. **用户确认 M1 通过** → 进 M2（范围见 `implement.md` M2 段）

## 预审发现（主会话预审，供 chatroom 评审用）

- `toPNG`/`toJPEG`/`toRGBA` 返回的 view 所指 leptonica 缓冲未释放（逐次泄漏；spike 有意接受，M2 API 需显式 release/free 设计）
- 依赖 tarball 仅 commit pin、无 sha256 校验（供应链小项）
- `-sFILESYSTEM` 未关（体积小项）

## 纪律（长期有效，违者返工）

- **本机零编译**：一切构建走 CI；本机仅 `node --check` / `npm test` / `tsc` 级验证（`.trellis/spec/build-ci/execution-discipline.md`）
- workflow `uses:` 必须先研究再 pin + 证据注释；禁止 `@vN` / `@main`
- 检索默认 zvec-grep；`rg` 仅精确串；ast-grep 最后回退
- `trellis-implement` / `trellis-check` 是子代理类型（Task 工具），不是 skill；dispatch 仅主会话可为
- 远端认证按 AGENTS.md 凭据纪律（本机 GCM 已存凭据可非交互 push；跨机需按纪律重新注入）；**任务收尾提醒用户轮换临时 token**
- 不 commit 用户未确认的变更；临时内容只落 `tmp/`
