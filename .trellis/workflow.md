# Development Workflow

This repository uses Trellis to keep requirements, design decisions, implementation context, reviews, and durable engineering rules close to the code.

## Core principles

1. Read the active task and applicable specifications before changing code.
2. Treat tracked source, tests, and workflow definitions as the operational source of truth.
3. Keep task artifacts concise, current, and repository-local.
4. Validate changes at the cheapest reliable layer first, then use CI for builds and platform-specific behavior.
5. Record durable rules in ".trellis/spec/" and task-specific evidence in ".trellis/tasks/".
6. Preserve unrelated user work and keep commits reviewable.

## Trellis layout

- ".trellis/spec/": durable package- and layer-scoped contracts.
- ".trellis/tasks/": active and archived task artifacts.
- ".trellis/workspace/": developer journals and session traces.
- ".trellis/scripts/get_context.py": context and phase discovery.
- ".agents/skills/": project-scoped Trellis helpers.

Each task may contain:

- "task.json": task metadata and status;
- "prd.md": goals, requirements, and acceptance criteria;
- "design.md": architecture and design decisions;
- "implement.md": milestone plan and reviewer procedure;
- "implement.jsonl": implementation context files;
- "check.jsonl": review context files;
- "research-*.md": task-specific evidence;
- "reviews/": milestone review records;
- "handover-*.md": concise continuation notes when needed.

## Session start

At the beginning of a development session:

1. Read this workflow.
2. Resolve the developer identity and active task with the Trellis context script when available.
3. Inspect Git status without modifying the worktree.
4. Read the active task in this order: "implement.jsonl", "prd.md", "design.md", "implement.md".
5. Read every specification that applies to the files being changed.
6. State the intended change boundary before implementation.

If automatic task discovery is unavailable, use the task explicitly named by the user. Do not initialize or migrate unrelated Trellis state merely to recover automatic discovery.

## Agent dispatch protocol

Every dispatched agent must make the platform's standard `create_goal` call its first action, before reading task files, analysing the code, editing, or reporting findings. The agent-owned goal must contain the business objective and this retry policy:

> Treat `stream disconnected`, HTTP `429`, and transient `5xx` network or service errors as retryable. Automatically retry with backoff and continue retrying; do not terminate or ask for user intervention solely because of these errors.

When the parent thread has an active goal, use a non-forked dispatch unless the platform proves goal state is isolated. Supply the required task context explicitly. An inherited parent goal does not satisfy the dispatched agent's own `create_goal` requirement.

The dispatch prompt must require this first action, but the prompt itself is not goal initialization. Until successful goal creation is confirmed, the instance is not started. If `create_goal` fails or the instance reports `GOAL_MISSING`, it must stop without task work; the main agent must not wait for, resume, or send task input to it, and must close it and create a replacement. Once the goal is active, preserve that instance across retryable transport or service failures.

The main agent owns active supervision. Confirm goal activation, check early progress and planned checkpoints, inspect raw status when progress is unclear, perform recovery or follow-up interactions when needed, and verify a terminal success or failure event. A timeout or disconnected stream is not a completion result.

## Phase Index

```text
Phase 1: Plan    -> define and review the task and its context
Phase 2: Execute -> implement and review only after task activation
Phase 3: Finish  -> verify, update durable rules, commit, and wrap up
```

[workflow-state:no_task]
No active task. Classify the request and obtain user consent before creating a Trellis task.
Use an existing task when the user identifies one. Do not create or activate unrelated task state merely to recover automatic discovery.
[/workflow-state:no_task]

[workflow-state:task_error]
The active task record is unreadable. Repair its task.json without creating or activating a replacement task.
Preserve existing fields and artifacts. Ask the user only when the correct state cannot be established from repository evidence.
[/workflow-state:task_error]

### Phase 1: Plan

- 1.0 Create or select a task `[required · once]`
- 1.1 Clarify requirements `[required · repeatable]`
- 1.2 Research `[optional · repeatable]`
- 1.3 Configure context `[required · once]`
- 1.4 Activate the task `[required · once]`
- 1.5 Planning completion criteria

[workflow-state:planning]
Stay in planning. Read and maintain `prd.md`; complex tasks also require `design.md` and `implement.md`.
Curate `implement.jsonl` and `check.jsonl`, review the artifacts with the user, then run `task.py start`.
Do not implement before activation. Every agent dispatch remains subject to the agent-owned `create_goal` and retry protocol in this workflow.
[/workflow-state:planning]

[workflow-state:planning-inline]
Stay in planning. Read and maintain `prd.md`; complex tasks also require `design.md` and `implement.md`.
Inline mode loads applicable specifications directly. Review the artifacts with the user, then run `task.py start`.
Do not implement before activation.
[/workflow-state:planning-inline]

### Phase 2: Execute

- 2.1 Implement `[required · repeatable]`
- 2.2 Quality check `[required · repeatable]`
- 2.3 Rollback `[on demand]`

[workflow-state:in_progress]
Read context in this order: `implement.jsonl`, `prd.md`, `design.md`, `implement.md`, then applicable specifications.
Flow: implement -> quality check -> specification update -> commit -> finish-work.
Every dispatched agent must first call standard `create_goal` for itself. Include the business objective and this policy in that goal: Treat `stream disconnected`, HTTP `429`, and transient `5xx` network or service errors as retryable; automatically retry with backoff and continue retrying; do not terminate or ask for user intervention solely because of these errors.
The dispatch prompt requires the first action but does not replace it. If goal creation fails or returns `GOAL_MISSING`, do not wait for, resume, or send task input to that instance; close it and create a replacement. After activation, retain and resume the same instance across retryable failures. The main agent confirms activation, checks early progress and planned checkpoints, inspects unclear status, performs recovery or follow-up interactions, and verifies terminal events.
[/workflow-state:in_progress]

[workflow-state:in_progress-inline]
Read context in this order: `prd.md`, `design.md`, `implement.md`, then applicable specifications.
Flow: implement inline -> quality check -> specification update -> commit -> finish-work.
Do not dispatch implement or check agents in inline mode.
[/workflow-state:in_progress-inline]

### Phase 3: Finish

- 3.1 Verification `[required · repeatable]`
- 3.2 Retrospective `[on demand]`
- 3.3 Update specifications `[required · once]`
- 3.4 Commit `[required · once]`
- 3.5 Wrap up

[workflow-state:completed]
Implementation and verification are complete. Ensure the work commit exists and the worktree is clean, then run `trellis-finish-work` for archive and journal bookkeeping.
[/workflow-state:completed]

Run required steps in order. Artifact presence may satisfy a `[once]` step. Return to planning when implementation reveals a requirements or design defect.

## Phase 1: Plan

#### 1.0 Create or select a task

Use an existing task when it already owns the requested outcome. Create a new task only for a distinct deliverable. Task names use a date prefix and a concise kebab-case title.

#### 1.1 Clarify requirements

Capture:

- the user-visible outcome;
- repository and ownership boundaries;
- required behavior and explicit exclusions;
- acceptance criteria;
- security, release, and compatibility constraints.

Ask only questions that materially change implementation or acceptance.

#### 1.2 Research

Research when the task depends on an unfamiliar API, external action, compiler behavior, supply-chain decision, or architectural precedent. Record primary evidence and the decision it supports. Keep external implementation details out of durable repository contracts unless they are direct dependencies.

#### 1.3 Configure context

Curate "implement.jsonl" and "check.jsonl" so implementation and review load the smallest complete set of authoritative files. Entries must be valid JSON Lines with a tracked file path and a clear reason.

#### 1.4 Activate the task

Mark the task active through the available Trellis command or metadata workflow. Do not create parallel active tasks for one outcome.

#### 1.5 Planning completion criteria

Planning is complete when the PRD is testable, design decisions are explicit, milestones are ordered, context files resolve, and applicable specifications are known.

## Phase 2: Execute

#### 2.1 Implement

For each milestone:

1. Load the milestone and applicable context.
2. Confirm the change boundary.
3. Make the smallest coherent implementation.
4. Add or update tests for changed contracts.
5. Run permitted local checks.
6. Use CI for compilation and other heavy or platform-specific verification.
7. Update task artifacts with decisions and evidence.

Use "apply_patch" for intentional file edits. Preserve unrelated changes. Use "pnpm" for JavaScript package operations.

#### 2.2 Quality check

Reviews verify:

- requirement and design compliance;
- type, test, and lint health;
- cross-layer data and control flow;
- public API and release surface;
- security and supply-chain boundaries;
- regression coverage and reproducibility evidence.

Record findings by severity, disposition, evidence, and verification. A non-gate milestone continues when actionable findings are cleared. A review gate also requires the explicit gate decision defined in the task.

#### 2.3 Rollback

Use reversible Git operations. Do not discard unrelated work. Destructive history or remote operations require explicit authorization and a verified target.

## Phase 3: Finish

#### 3.1 Verification

Run the checks appropriate to the change. For this repository, the standard lightweight set is "pnpm test", "pnpm run typecheck", and "git diff --check". Add task-specific checks such as release-contract tests. Compilation remains CI-owned unless the user explicitly authorizes a local build.

#### 3.2 Retrospective

When a failure reveals a reusable rule, record the smallest durable contract in the relevant specification. Keep incident detail in the task review or journal.

#### 3.3 Update specifications

Update specifications only for behavior that future work must follow. Use international English, positive descriptions, clear ownership, and repository-local terminology.

#### 3.4 Commit

Before committing:

1. inspect status and the staged diff;
2. verify no credential material or local credential filenames are tracked;
3. confirm tests and required CI evidence;
4. use a concise conventional subject;
5. keep fix rounds in the logical commit through fixup and rebase when history is still private.

Small pull requests are merged with squash semantics so the target branch receives one logical commit. Do not create a separate merge commit with a duplicate subject.

#### 3.5 Wrap up

Report the outcome, verification, commit or branch state, remaining operational prerequisites, and any user-owned action. Remind the user to rotate temporary credentials when relevant without naming local credential files in tracked content.

## Guardrails

- Never read secret values or local credential files.
- Never place credentials in command arguments, remote URLs, logs, tracked files, or agent context.
- Never compile or install the heavy WebAssembly toolchain locally without explicit approval.
- Never use floating GitHub Action references.
- Never weaken toolchain drift checks to make CI green.
- Never add registry publication; GitHub Release is the distribution channel.
- Never expose private release-variant configuration in the public builder payload.
- Never treat documentation-only edits as requiring CI monitoring unless a workflow contract says otherwise.

## Customization

Project-specific changes to this workflow must remain platform-neutral and must preserve the task lifecycle, context-loading contract, execution discipline, and review evidence model.
