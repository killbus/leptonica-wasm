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

## Local credential safety rules

The development machine may contain temporary local credential files. They are excluded only through `.git/info/exclude` and must never be committed; consult that local file for the actual entries.

- **Never read credential file contents directly.** Do not use file-reading tools, shell display commands, or any mechanism that places a credential value in conversation context, command arguments, remote URLs, environment dumps, or logs.
- **Authenticate Git and GitHub operations through stdin.** Pass credentials directly to the approved credential-helper or CLI stdin protocol without expanding the value into agent-visible text.
- **Credential filenames must not appear in tracked files**, including `.gitignore`; tracked filenames are public metadata.
- Treat local tokens as temporary and remind the user to rotate them when the task is complete.

## Search tool preference

- **Use `zvec-grep` (`zg`) as the default code and content search tool, ahead of `rg` and `ast-grep`** (user direction, 2026-09-03).
  - **Use `zvec_grep_search` by default** for concepts, semantics, relationships, cross-file behavior, architecture, data or control flow, causal or temporal questions, paraphrases, and implementation searches described by behavior rather than an exact token.
  - **Use `rg` only as the exact-text fast path** for known literals, regular expressions, configuration keys, error strings, or exhaustive occurrence lists. Prefer `zvec_grep_rg` when the host exposes it.
  - **Use `ast-grep` only as the final fallback** after `zg`, when a concrete AST pattern is available and semantic search did not find the target. Use the `ast-grep` CLI; `sg` is deprecated.
  - Do not skip semantic or relationship search merely because `rg` is more familiar.
- Installed fallback tools are `rg` with PCRE2 support and `ast-grep`; they are fallback paths, not the default.
- The host selects chatroom and review perspectives directly; user confirmation is not required for each persona (user direction, 2026-09-03).

## Agent dispatch protocol

- Every dispatched agent must call the platform's standard `create_goal` mechanism as its first action, before reading task files, analysing code, editing, or reporting findings. Its goal must contain the exact assignment and require automatic backoff and retry for `stream disconnected`, HTTP `429`, and transient `5xx` network or service errors, without terminating or asking the user to intervene solely for those errors.
- When the parent thread has an active goal, use a non-forked dispatch unless the platform proves goal state is isolated. Pass the required task context explicitly; an inherited parent goal is not the dispatched agent's own goal.
- A dispatch prompt is only an instruction to initialize; it is not a substitute for the agent-owned goal. Until successful goal creation is confirmed, the instance is not started. On creation failure or `GOAL_MISSING`, stop and close it, do not wait for, resume, or send task input to it, and create a replacement.
- After goal activation, preserve the same agent across retryable transport or service failures. Resume it with backoff and actively supervise it through an early status check, planned progress checkpoints, recovery interactions when needed, and a verified terminal event. A timeout or disconnected stream is not completion.
- If a requested model route is unavailable or the effective routed model does not match a user requirement, do not dispatch under a substitute identity. Continue in the main agent or wait for the required route.

## Build and CI execution discipline

- **No heavy local work.** Do not install or run emsdk, compiler suites, or compilation on the development machine. Heavy work belongs in GitHub CI. Local work is limited to editing, header or text parsing, and lightweight `pnpm test` or type-check validation unless the user explicitly approves a local build.
- **Research GitHub Actions before use.** Before adding a workflow `uses:` entry, identify its repository, inspect the latest applicable release and official documentation, and pin the documented action to an immutable commit. Do not guess `@vN` or use floating `@main`. Record the source URL, release tag, and date in a workflow comment or research note.
- **Use the owned temporary paths.** Runtime-fetched dependencies, toolchains, and build trees belong under the ignored `tmp/` hierarchy, with functional subdirectories such as `tmp/deps/`. Read-only reference repositories belong under manifest-managed `third_party/`. Outputs belong under `dist/`. Do not use `build/deps` or introduce `./temp`. See `.trellis/spec/build-ci/execution-discipline.md`.
