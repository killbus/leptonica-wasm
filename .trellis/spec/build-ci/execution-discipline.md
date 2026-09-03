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

## Common Mistakes

### 本机装工具链「图省事」

- **Symptom**：agent 计划本地装 emsdk「先验证可行性」。
- **Cause**：把「快速验证」置于执行纪律之上。
- **Fix**：可行性验证就是 CI workflow 本身（加 `workflow_dispatch` 手动触发，分钟级反馈）。
- **Prevention**：dispatch prompt 写明「本机零重任务」；本 spec 常读。

## 一句话版

> 开发机产出代码与 workflow；GitHub Actions 产出一切二进制。
