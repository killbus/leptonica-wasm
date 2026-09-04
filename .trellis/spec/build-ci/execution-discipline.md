# 构建与 CI 执行纪律

> 来源：2026-09-03 用户指示（M1 执行纠偏）。三条规则为硬约束，适用于所有 agent（主会话与子代理）在本仓库的一切构建/CI/路径操作。违反即返工。

## 规则 1：本机零重任务（重活 → GitHub CI）

### Scope / Trigger

任何涉及「安装工具链、编译、链接、运行构建产物」的工作。

### 契约

- 本机允许：文件编辑、文本/头文件解析（如 gen-exports.mjs 扫 `allheaders.h`）、`npm test` / `npx tsc --noEmit` 级验证、git/gh 操作、workflow YAML 编写、`node --check` 语法验证。
- 本机禁止：安装 emsdk / cmake / ninja / 编译器套件（含「先装了试试」的探索性安装）、执行任何编译/链接、跑冷全量构建。
- 一切编译与构建在 GitHub Actions workflow 内执行，含开发迭代验证——本仓库不存在「本地开发构建」层。
- 逃生阀：确需本机重构建（如 CI 不可复现问题调试）→ 必须先获用户明确批准；工具链与构建树限 `tmp/`，事后清理。

### Validation & Error Matrix

| 条件 | 处置 |
| --- | --- |
| 计划/命令中出现本机安装工具链或执行编译 | 停止，改派 CI workflow |
| 子代理任务书含本地编译指令 | 停下并向上询问（M1 先例：emsdk activate 被用户拒绝） |
| 用户已批准的本机重构建 | 允许，产物限 `tmp/`，事后清理 |

### Wrong vs Correct

```text
# Wrong：在开发机装工具链并本地编译（M1 实际发生，被用户拒绝）
git clone emsdk → emsdk activate → emcmake cmake … → ninja …

# Correct：本机写 workflow，构建在 CI 执行
# .github/workflows/size-spike.yml：研究过的 actions + emsdk pin 安装 + build.mjs + 冒烟 + 采集
git add .github/workflows/size-spike.yml && git commit && git push
```

## 规则 2：GitHub Actions 先研究后使用

### Scope / Trigger

在 `.github/workflows/*.yml` 中写入或修改任何 `uses:` 引用。

### 契约（三步研究，缺一不可）

1. **构建仓库 URL**：由 action 名 `owner/repo` 构造 `https://github.com/<owner>/<repo>`。
2. **查最新 release**：`gh api repos/<owner>/<repo>/releases/latest`（或 `Invoke-RestMethod https://api.github.com/repos/<owner>/<repo>/releases/latest`）取 `tag_name` 与 release 说明。
3. **读官方文档**：仓库 README / docs 的推荐用法、inputs、迁移说明；按文档写 step。

硬性要求：

- 按研究确认的最新 release + 官方文档推荐方式引用。
- 禁止凭记忆写 `@vN`；禁止浮动 `@main` / `@master`。
- 研究证据（repo URL、release tag、查询日期、要点）写入 workflow 内 step 上方注释或研究文档。

### Validation & Error Matrix

| 条件 | 处置 |
| --- | --- |
| workflow 出现未研究的 `uses:` | 阻断：先研究再落笔 |
| 凭记忆 `@vN` 或浮动 `@main` | 阻断：改为研究确认的引用 |
| upstream 已大版本迁移（文档标 breaking） | 按最新 major 文档写法重写 step |

### Good / Base / Bad

- Good：`actions/checkout` → 查 latest release tag → README 确认 `with:` 用法 → 注释 `# researched 2026-09-03: <url>, latest release <tag>`。
- Base：`run:` 直跑 npm/node 的步骤无需研究——纪律只约束 `uses:`。
- Bad：抄旧项目 YAML 不查证；`uses: actions/setup-node@main`。

## 规则 3：临时内容路径纪律

### 契约（路径表）

| 内容 | 路径 | git 状态 |
| --- | --- | --- |
| 运行期 fetch 的依赖源码 | `tmp/deps/` | `.gitignore` 排除 |
| 构建树 / 中间产物 | `tmp/build/` | 排除 |
| 获批的本机工具链（仅逃生阀场景） | `tmp/tools/` | 排除，事后清理 |
| 发布产物 | `dist/` | 不入 git（design §3） |
| 参考仓库（只读对照） | `third_party/` | `manifest.json` tracked，内容本地排除 |
| 依赖版本 pin | `vendor/versions.json` | tracked |

- 新增临时目录 → 先同步 `.gitignore`，再写文件。
- 禁止：`build/deps`（M1 旧路径，已废弃）、`./temp`；`build/` 一词不再用于本仓库路径。

### Wrong vs Correct

```text
# Wrong：fetch 的依赖源码落 build/deps/（M1 子代理实际发生，已纠正）
Invoke-WebRequest … -OutFile build/deps/leptonica.tar.gz

# Correct：
Invoke-WebRequest … -OutFile tmp/deps/leptonica.tar.gz
```

## 规则 4：主会话对子代理/worker 的 monitor 职能（2026-09-04 用户指示）

### Scope / Trigger

主会话（dispatcher）派出任何后台执行体——`trellis channel spawn` 的 worker、后台 Bash、后台 Agent——之后的时间窗。

### 契约

- **派即监**：dispatch 不是终点。任何后台执行体启动后，主会话必须持有其完成信号的监督手段（harness 原生通知、`wait --kind done,error`、或显式轮询），且监督必须覆盖**失败信号**（error/killed/非零退出），不只是成功信号。fire-and-forget 禁止。
- **早失败检测**：spawn 后的最初 2 分钟是死亡高峰（spawn 失败、context 超限、provider 报错）。监督的第一职责是尽早发现"根本没跑起来"，而不是等超时。判据：worker 日志/事件流出现 `error` 类事件，或产出体积/事件数长时间为零且无 progress。
- **timeout ≠ 完成判据**：`wait` 超时（exit 124）意味着"没等到"，必须回到事件流核实实际状态（done/error/仍活着），不得假定成功也不得静默重试。
- **失败处置**：确认执行体死亡后——收集死因（worker 日志 `*.log`、channel 事件流 `--raw`）→ 修复或绕行 → 重派。绕行时要保留失败证据供事后归档（M1 先例：channel worker 因 pnpm shim 不被 trellis resolveProviderPath 支持 spawn ENOENT → 改用 Agent 工具直派，channel 事件流留档）。
- **适用范围**：同一纪律适用于 Agent 工具的后台 subagent 与 4xx/5xx 网络错误的重试节奏（指数退避，不静默放弃）。

### Validation & Error Matrix

| 条件 | 处置 |
| --- | --- |
| 后台 worker spawn 后无监督手段 | 阻断：先建立监督再继续主线工作 |
| `wait` 超时退出 | 核实事件流实际状态，禁止假定成功 |
| worker 日志出现 error 事件 | 停止等待，诊断死因，决定修复/绕行 |
| 子代理/worker 连续失败 | 按指数退避重试；仍失败换通道（如 channel → Agent 工具） |

### Wrong vs Correct

```text
# Wrong：spawn 三个 worker 后直接 wait done，只等成功不看 error；
# worker 早已 error 死亡，wait 挂到超时（M1 实际发生，25 分钟后用户发现）
trellis channel spawn … ×3
trellis channel wait … --kind done --timeout 29m   # 只订阅 done，漏 error

# Correct：wait 同时订阅 done,error；超时后回查 --raw 事件流
trellis channel wait … --kind done,error --all --timeout 29m
# 超时/可疑时：
trellis channel messages <ch> --raw --last 10     # 核实真实状态再行动
```

## Common Mistakes

### 本机装工具链「图省事」

### 派后不监，靠用户发现卡死

- **Symptom**：三个 reviewer worker spawn 后全部 ENOENT 死亡，主会话只挂 `wait --kind done`，25 分钟无输出，用户主动问"是不是卡住了"。
- **Cause**：wait 只订阅成功信号；spawn 失败写入的是 `error` 事件，从未被消费。监督缺位 + 失败信号盲区叠加。
- **Fix**：wait 一律 `--kind done,error`；spawn 后数分钟内主动抽查一次事件流确认 worker 真的活起来了。
- **Prevention**：本规则 4；channel runtime 的 provider 解析在 pnpm 安装环境下有上游 bug（trellis 0.6.16 resolveProviderPath 只认 npm 格式 .cmd shim），Windows + pnpm 环境暂用 Agent 工具直派替代。


- **Symptom**：agent 计划本地装 emsdk「先验证可行性」。
- **Cause**：把「快速验证」置于执行纪律之上。
- **Fix**：可行性验证就是 CI workflow 本身（加 `workflow_dispatch` 手动触发，分钟级反馈）。
- **Prevention**：dispatch prompt 写明「本机零重任务」；本 spec 常读。

## 一句话版

> 开发机产出代码与 workflow；GitHub Actions 产出一切二进制；派出的一切执行体都在主会话的监督之下。
