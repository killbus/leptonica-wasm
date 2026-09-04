# 交接：leptonica-wasm-modern — M2 收尾评审段接管

> 产自主会话（M2 全部清单条目落地 + CI 验证 + 文档回填完成后）。收件方：接手的团队成员。
> 前序交接：`handover-team-c.md`（M1 尾段）——纪律与环境部分仍全部有效，本篇只讲增量。

## 仓库与任务状态

- **任务路径**：`.trellis/tasks/09-03-leptonica-wasm-modern`（Trellis 管理，in_progress）
- **仓库**：`github.com/killbus/leptonica-wasm`，M2 收口于 `cc134bf`（已 push；本地工作树干净）；其后提交仅含本交接文档
- **恢复上下文**：新会话跑 `trellis-start`；按序读 `implement.jsonl` → `prd.md` → `design.md` → `implement.md`
- **当前里程碑**：M2 全部清单条目 [x]、验证行达成（证据见 implement.md M2 段与下文「已完成」）。**M2 评审未启动**——这是接手方的第一件事。

## 已完成（勿重做）

M2 六条目全部落地。增量（相对 handover-team-c.md 时点）：

1. **build.mjs 完整化**（commits 069e8df + 78138ef + d81795b）：开关名裁决统一 `--full-abi`；`.done` 标记纳入 pin+flags+工具链 commit 失效；curl 下载原子性（.part+rename）；build-report 增 jsGzipBytes + provenance 字段；`--opt` 开关（与 `--full-abi` 冲突拒绝）；**CMAKE_POLICY_VERSION_MINIMUM=3.5 已移除**（run 33899237236 验证：缓存键轮换触发四依赖冷配置，零 policy 错误）；full-abi outdir 隔离。
2. **check-exports.mjs**（commit 809215d）：按模式分层比较 + 库级解码符号缺席断言（png_read_*/jpeg_read_header 等 = 0）；四路变异测试全红。
3. **PR CI**（commits 1f10e84 + 78138ef + 05e1e40）：pin 从 versions.json 注入；缓存分层（emsdk 版本键 / deps pin+工具链+hashFiles(build.mjs) 键）；compare job 跨 runner 四产物哈希全等（supply N3 缓存内容复验）；runner pin ubuntu-24.04；**工具链 sha256 白名单接线**（冷装路径 EMSDK_KEEP_DOWNLOADS=1 → verify → 再入缓存层）。
4. **供应链防线**（commits 6d474f7 + 05e1e40）：gitleaks secret 扫描（每日 cron + 全历史）首跑绿；dependabot（github-actions + npm 生态，分组小步）落地当天即出首个更新；工具链四归档 file/bytes/sha256 白名单（记录自 run 33870871356，冷装验证 4/4，runs 33884503228/33899237236）。
5. **toGray 手算金样**（commit 78138ef）：2×2 锚点 + grayAnchor() JS 镜像实现（Math.fround 严格对应 C 晋升链）+ 五滤波 PNG 解码器。权重是 **0.3f/0.5f/0.2f 感知权重，不是 BT.601**——改断言前先读 research 记录。
6. **验证行达成**：缓存命中（run 33864372196 双命中 emsdk 509MB/deps 43MB）；CI 全绿链：33855910354 → 33884503228 → 33899237236 → 33906993273（最新，docs push 触发，缓存全命中 2m9s）。

## 待办（严格按序）

1. **M2 评审**（非门里程碑，findings 清零即继续，无需用户确认）——按 implement.md「Reviewer SOP」：
   - 第一层 dispatch `trellis-check`（prompt 以 `Active task: .trellis/tasks/09-03-leptonica-wasm-modern` 开头）
   - 第二层 chatroom 三视角：**CI 可复现性 / 导出面安全（无解码入口）/ 缓存有效性**
   - findings 处置 → 记 `reviews/M2.md` → 清零 → 进 M3
2. **分支保护**（supply W3，用户裁决「与白名单信任根同批」）：需要 repo admin 在 GitHub Settings → Branches 给 `main` 加规则（Require PR + Block force pushes），或授权 `gh api` 执行。**这是白名单的信任根，未做前白名单是装饰**。接手方接手后提醒用户完成。
3. 开着的 dependabot PR `#1`（dev-deps 分组，2 updates）：评审合并即可——CI 会全链验证，合并后确认三 job 绿。
4. M3 起见 `handover-team-c.md` 的「预审发现」里 spike 期有意接受的 API 泄漏问题：那是 M3/M4 API 设计的输入，不是 M2 遗留。

## 关键机制备忘（防误伤）

- **验证只在冷装路径发生**：emsdk 缓存命中时跳过 install → 也就跳过 verify-toolchain。这是设计（缓存内容已由 supply N3 的 compare job 复验），不是漏掉。**别「补」缓存命中路径的 verify**——那会要求每次缓存命中都带着 430MB 归档，缓存就废了。
- **verify-toolchain 集合相等强制**：emsdk bump 后必须先 dispatch toolchain-hash workflow 再改 versions.json 的 pin，否则 CI 红且错误信息指明 drift。别绕开这个红——它是白名单的再生成纪律执行者。
- **deps 缓存键含 hashFiles(build.mjs)**：任何 build.mjs 编辑（哪怕注释）都会轮换缓存键触发全量冷编译。预期行为，不是故障。
- **secret-scan 双触发面**：push/PR 即跑 + 每日 cron（历史面）。若 gitleaks 对仓库内容误报，先确认不是真泄密再调整忽略模式，调整结果同步固化到 `.gitignore`（supply N5 原文要求）。
- **toGray 权重是感知权重**：smoke.mjs 的像素级断言钉死 0.3f/0.5f/0.2f，不是 BT.601。任何“顺手修正为 BT.601”的改动都会红——这是刻意的。
- **本机 Node 24 跑 `npm test` 可能看到 vitest loader 报错**（TypeError reading 'config'）：已在干净 HEAD 上排除是仓库问题，CI Node 20 全绿，CI 是权威。本地忽略，别修。

## 纪律（长期有效，违者返工）

同 `handover-team-c.md` 纪律节，全部适用。补充三条 M2 段新增的：

- **docs-only push 不需要挂 CI 监控**（用户 2026-09-04 裁定）：实现变更的 push 才需要派即监。监即读——终态事件到达后必须立即消费，不得继续“仍在等待”式汇报。
- **监控用完即停**：Monitor 到终态自然结束；用户中断说“监控停了吧”就立即 TaskStop，不要遗留。
- **语义不变的实现修复**：fixup/rebase + force push（需分支保护落地后改走 PR），不堆叠 commit。
