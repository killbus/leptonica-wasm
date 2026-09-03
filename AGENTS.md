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

- 内容检索优先用 `rg`（ripgrep，经 Bash 调用）代替 Grep 工具/Select-String；本机已装 ripgrep 15.2.0（含 PCRE2）。
- 结构化代码检索（按语法模式而非文本匹配找代码）用 `ast-grep`（CLI 名 `ast-grep`，`sg` 已弃用）；本机已装 ast-grep 0.45.0，规则写法参考 ast-grep skill。
- agent 主持的 chatroom/评审人格由主持方直接选定，无需用户逐次确认（2026-09-03 用户指示）。
