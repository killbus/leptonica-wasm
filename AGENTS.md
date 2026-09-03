<!-- TRELLIS:START -->
# Trellis Instructions

These instructions are for AI assistants working in this project.

This project is managed by Trellis. The working knowledge you need lives under `.trellis/`:

- `.trellis/workflow.md` — development phases, when to create tasks, skill routing
- `.trellis/spec/` — package- and layer-scoped coding guidelines (read before writing code in a given layer)
- `.trellis/workspace/` — per-developer journals and session traces
- `.trellis/tasks/` — active and archived tasks (PRDs, research, jsonl context)

If a Trellis command is available on your platform (e.g. `/trellis:finish-work`, `/trellis:continue`), prefer it over manual steps. Not every platform exposes every command.

If you're using Codex or another agent-capable tool, additional project-scoped helpers may live in:
- `.agents/skills/` — reusable Trellis skills
- `.codex/agents/` — optional custom subagents

Managed by Trellis. Edits outside this block are preserved; edits inside may be overwritten by a future `trellis update`.

<!-- TRELLIS:END -->

## 本地凭据安全规则（长期有效）

开发机上可能存在本地临时凭据文件（仅通过 `.git/info/exclude` 本地排除，永不入库；具体条目见该文件）：

- **禁止直接读取凭据文件内容**：不得用 Read 工具、Get-Content/cat、echo 或任何方式将凭据值引入会话上下文、命令行、remote URL、环境变量或日志。
- **git 远端交互的认证一律通过 stdin 注入 credential helper**：凭据经 shell 子表达式在运行时读出并管道喂给 `git credential approve`（credential helper 协议），agent 永不展开值。
- **凭据文件名不得出现在任何 tracked 文件中**（含 `.gitignore`——tracked 文件会公开文件名）。
- token 为临时性质，任务收尾时提醒用户轮换。

## 工具偏好（长期有效）

- **代码/内容检索：`zvec-grep`（zg）为默认首选，优先级高于 `rg`、`ast-grep`（2026-09-03 用户指示）**
  - **默认 `zvec_grep_search`**：概念、语义、关系、跨文件、架构、"X 如何工作"、数据/控制流、因果/时序、同义改写、"找实现某行为的代码"（以语义而非精确串描述）——一律先 zg。这是默认路径，非可选项。
  - **`rg` 仅作精确串快速路径**：目标为纯字面量 / 正则 / 配置键 / 报错串 / 穷举出现位置、且已握确切 token 时，才用原生 `rg`（本 host 若列出 `zvec_grep_rg` 则优先用它）。
  - **`ast-grep` 仅作最后回退**：先 zg；握有具体 AST 模式且 zg 未命中才用（CLI `ast-grep`，`sg` 已弃用；本机 0.45.0，规则参考 ast-grep skill）。
  - **禁止**：因"rg 更快 / 更熟"而跳过 zg 的语义与关系检索——那恰是 zg 的适用场景，属误用。
- 回退工具已装：`rg`（ripgrep 15.2.0，含 PCRE2，经 Bash）、`ast-grep` 0.45.0；二者为兜底，非默认。
- agent 主持的 chatroom/评审人格由主持方直接选定，无需用户逐次确认（2026-09-03 用户指示）。

## 构建与 CI 执行纪律（长期有效，2026-09-03 用户指示）

- **本机零重任务**：不在开发机安装/运行重型工具链（emsdk、编译器套件）或执行任何编译；一切重活走 GitHub CI。本机仅做编辑、头文件/文本解析、npm test/typecheck 级验证；确需本机重构建须用户明确批准。
- **GitHub Actions 先研究后使用**：workflow 中任何 `uses:` 前，构建其仓库 URL → 查最新 release 与官方文档 → 按文档用法引用；禁止凭记忆写 `@vN`、禁止浮动 `@main`；研究证据（URL、release tag、日期）留 workflow 注释或研究文档。
- **临时内容路径**：运行期 fetch 的依赖源码/工具链/构建树落 `tmp/`（gitignored，按职能分子目录如 `tmp/deps/`）；参考仓库只读放 `third_party/`（manifest 管理）；产物落 `dist/`；禁止 `build/deps`，不引入 `./temp`。详见 `.trellis/spec/build-ci/execution-discipline.md`。
