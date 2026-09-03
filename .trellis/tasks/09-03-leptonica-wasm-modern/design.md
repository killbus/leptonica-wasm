# leptonica-wasm 设计文档

上游：`prd.md`（14 条决策 + R1–R5 需求 + 8 类算子清单）。本文件把决策落成可实施的架构。

## 1. 架构总览

```
┌─ 主线程 / Node ────────────────────────────────────────────┐
│  leptonica-wasm (npm)                                      │
│  ├─ Worker 会话客户端（推荐入口）                             │
│  │   createSession() → load/chain/query/extract/close       │
│  ├─ 同步核心（一等公民，Worker 内部同款）                      │
│  │   Leptonica.load() → fromRGBA → chain().run() → 提取      │
│  └─ raw 层（逃生舱：全量 C ABI，松类型，无 semver）            │
└──────────────┬─────────────────────────────────────────────┘
               │ 消息：句柄 ID + 可序列化算子描述 + ArrayBuffer transfer
┌──────────────▼─────────────────────────────────────────────┐
│  Worker（浏览器 Worker / Node worker_threads）               │
│  同步核心实例 + 句柄表 Map<HandleId, Pix*>                   │
│  session.close() = 竞技场全量释放（唯一生命周期契约）            │
│  session.terminate() = worker.terminate() 核弹选项            │
└─────────────────────────────────────────────────────────────┘
```

关键不变量（对应 PRD 决策 ③④⑫⑬⑭）：

1. RGBA 像素只在边缘进出（`load` 上行、`extract` 下行），链上传句柄；链上 1bpp 语义不被抬升。
2. 链的中间 Pix 在单次 `run()` 调用栈内生灭。
3. 生命周期契约只有一个：Worker 模式 `session.close()`（全量释放）；同步核心显式 `dispose`（`Symbol.dispose` + 毒化）。
4. 算子 = 可序列化描述（tagged union），同步核心与 Worker 客户端共用同一套描述——这就是「builder vs per-op」缝合线的裁决（见 §5.1）。

## 2. 仓库与包结构

```
leptonica-wasm/
  cpp/
    bindings.cpp          # embind 精选层（手写，唯一 semver 承诺）
  scripts/
    build.mjs             # 构建编排：拉取 pin 依赖 → emcmake → ninja → 产物
    gen-exports.mjs       # 扫 allheaders.h → raw 层 EXPORTED_FUNCTIONS + 松 d.ts
    check-exports.mjs     # CI：d.ts 符号 vs WebAssembly.Module.exports diff
  src/
    index.ts              # 公共出口
    load.ts               # Leptonica.load()
    protocol.ts           # Op tagged union + 消息类型（sync/worker 两端共用）
    core/                 # 同步核心 TS 包装（Pix、chain builder、查询、提取）
    worker/               # 会话客户端 + worker 入口 + Node worker_threads 适配
    raw/                  # C ABI 松类型包装（危险区）
  tests/
    node/                 # vitest 单测（同步核心 + worker_threads 协议）
    browser/              # Playwright E2E
  vendor/versions.json    # 全部依赖精确 commit pin
  dist/                   # 构建产物
```

- 包形态：ESM-only（v0.1），`exports` 映射主入口与 `./worker` 子路径；后续 CJS 需求出现再议。
- npm 包名 M0 查重后定（`leptonica-wasm` 若被占则选替代）。

## 3. 构建管线

**依赖 pin**（`vendor/versions.json`，全部精确 commit）：

| 依赖 | 角色 |
| --- | --- |
| leptonica | 主体，pin 当期最新稳定 release |
| zlib | png 后端 |
| libpng | PNG 编解码 |
| libjpeg-turbo | JPEG 编解码 |
| emsdk | 工具链，pin 精确 release tag（如 `sdk-release-<tag>-64bit`） |

**编排**（`scripts/build.mjs`，参考 tesseract-wasm 证据）：

1. fetch：按 pin 拉源码到 `build/deps/`（浅 clone 或 tarball，本地缓存）。
2. 逐依赖 `emcmake cmake + ninja` 构建静态库（zlib → libpng → libjpeg-turbo → leptonica）。
3. `emcc` 编译 `cpp/bindings.cpp` 并链接全部静态库 → 单 `leptonica.wasm` + ESM glue。

**Leptonica CMake 开关**（起点组合，构建期调通为准）：`HAVE_LIBJPEG/LIBPNG` 留，`LIBWEBP/OPENJPEG/GIFLIB` 全 OFF；`-DCMAKE_POLICY_VERSION_MINIMUM=3.5`（tesseract-wasm 已验证）。

**编译参数**（起点）：

- `-sMODULARIZE=1 -sEXPORT_ES6=1`（ESM glue）
- `-sALLOW_MEMORY_GROWTH=1`，`INITIAL_MEMORY` 32MB，`MAXIMUM_MEMORY` 可配
- `-sENVIRONMENT=web,worker,node`
- `--emit-tsd`（d.ts 产出，见 §6）
- `-O3` + `-sWASM_BIGINT`；SIMD 不做构建变体（决策 ⑨，运行时 `WebAssembly.validate` 探测暴露能力标志）

**体积控制**：

- 精选层只引用所需 leptonica 函数 → `EXPORTED_FUNCTIONS` 白名单 + 链接器 gc-sections 裁剪；不暴露 `pixRead*` 则解码路径被裁剪（M1 spike 验证）。
- raw 层全量 C ABI 导出有体积代价（导出表 + 函数名字符串 + 阻止裁剪），代价数值由 M1 spike 测量；若代价过高，默认产物 = 精选构建，`--raw-abi` 构建（或 `/full` 子导出）承载全量逃生舱——回填 PRD 决策 ⑦ 的 core/full 裁决。

**构建分发策略：CI 是发布产物唯一来源**——冷全量构建是重任务（分钟到十分钟量级，emsdk 下载数百 MB；实测基线 M1 记录），因此职责分两层：

- **本地构建 = 开发迭代**：deps 静态库一次构建后缓存（键 = versions.json），日常改动只 ninja 增量 + emcc 重编 `bindings.cpp` 单文件（秒级）；本地产物**不用于发布**。
- **CI 构建 = 产物唯一来源**：干净环境全量构建；PRD「可复现构建」验收由 CI 证明而非任何本地机器；release workflow（tag 触发）build → test → `npm publish --provenance`（决策 ⑪ 的 provenance 本就要求 CI 内发布）。
- **CI 缓存分层**（冷构建压回分钟级）：emsdk 按精确版本键；deps 源码 + 静态库产物按 versions.json + 工具链哈希键；原生构建产物同键独立缓存。
- **dist 不入 git**（M0 `.gitignore` 已列）：仓库提交产物有漂移与历史膨胀风险，产物以 workflow artifact / npm 包承载。

## 4. 双层 API

### 4.1 精选层（承诺层）

```ts
// 加载
const lp = await Leptonica.load();              // 实例化 wasm 模块

// ── 同步核心（Worker 内部同款；Node / 已在 worker 里的用户直用）──
using src = lp.fromRGBA(rgba, w, h);            // Pix 句柄（32bpp）
const out = lp.chain(src)
  .toGray()                                     // 8bpp
  .otsu({ tile: 16 })                           // 1bpp
  .dilate(3)                                    // Sel brick 3×3
  .run();                                       // 同步执行，返回结果 Pix
const png  = out.toPNG();                       // Uint8Array —— 提取即终点
const { angle, confidence } = lp.findSkew(out); // 查询：返回值，不产生 Pix

// ── Worker 会话客户端（推荐入口，文档主入口）──
const session = await createSession();
const img = await session.load(rgba, w, h);     // ArrayBuffer transfer → 句柄代理
const result = await session.chain(img)
  .toGray().otsu({ tile: 16 }).dilate(3)
  .run();                                       // 一次 round trip（整链一条消息）
const bytes = await result.toPNG();             // transfer 回主线程
const n = await session.countPixels(result);     // 查询
await session.close();                          // 全量释放；此后任何调用抛错
```

**Pix（同步核心）语义**：

- `Symbol.dispose` → `pixDestroy` + 毒化（disposed 后任何方法 throw `ReferenceError` 风格错误）。
- `using` 语法糖（TS 5.2+）；忘记 dispose 时 `FinalizationRegistry` 仅 console.warn 报泄漏（决策 ④：报警不兜底，仅 dev 模式启用）。
- `chain().run()` 只产生一个结果句柄；中间 Pix 在 run() 调用栈内 pixDestroy。
- 查询类方法直接返回值（number / 数组 / 对象），不产生 Pix。

**句柄代理（Worker 模式）**：主线程轻量对象，持有 `HandleId`；可继续 chain、可 extract、可 query；close() 后全部毒化。v1 无逐对象远程 dispose（决策 ⑭，v0.2 候选——若加，配世代句柄防双删）。

### 4.2 算子映射表（v0.1，函数名以 M4 对 allheaders.h 逐一核实为准）

| 精选 API | Leptonica 候选 | 备注 |
| --- | --- | --- |
| `fromRGBA(data, w, h)` | `pixCreateNoInit` + `pixSetRGBAPixels`/setData | 入口，32bpp |
| `toRGBA()` | `pixGetRGBAPixels`（若无则行指针拷贝） | 提取 |
| `toPNG({level})` | `pixWriteMemPNG` | |
| `toJPEG({quality})` | `pixWriteMemJpeg` | |
| `toGray(weights?)` | `pixConvertTo8` | 可选亮度权重 |
| `threshold(level)` | `pixThresholdToBinary` | |
| `otsu({tile})` | `pixOtsuAdaptiveThreshold` | 分块自适应 |
| `sauvola({whsize, factor})` | `pixSauvolaBinaConstant` 系 | 需 8bpp |
| `deskew({reduction})` | `pixDeskew` | 内部 findSkew |
| `findSkew()` 【查询】 | `pixFindSkew` | 1bpp，返回 `{angle, confidence}` |
| `rotate(angle, {quality})` | `pixRotate` / `pixRotateAM` | 选型 M4 |
| `scale(fx, fy)` | `pixScale` 系 | 选型（一般/锐利）M4 |
| `shear(dir, angle)` | `pixHShear` / `pixVShear` | |
| `clip(x,y,w,h)` | `pixClipRectangle` | Box 内部构造 |
| `translate(dx,dy)` | rasterop/shear 组合（leptonica 无现成单函数则组合） | M4 核实 |
| `dilate/erode/open/close(w,h)` | brick Sel + DWA 快速路径优先（`pixDilateBrickDwa` 系） | Sel 由参数构造，不暴露 |
| `connComp()` 【查询】 | `pixConnComp` → boxa | 返回 `Box[]` |
| `countPixels()` 【查询】 | `pixCountPixels` | 1bpp |
| `histogram()` 【查询】 | `pixGetGrayHistogram` 系 | 8bpp → `number[]` |
| `average()` 【查询】 | `pixGetAverage` 系 | |
| `sobel({orientation})` | `pixSobelEdgeFilter` | |
| `or/and/xor(other)` | `pixOr` / `pixAnd` / `pixXor` | 1bpp 二元，参数是另一句柄 |
| `blend(other, {frac})` | `pixBlend` | |
| `addBorder(t, {val})` | `pixAddBorder(s)` | |

类型规则（决策 ③）：链上每步校验源 depth（如 sauvola 需 8bpp、or 需 1bpp、sobel 需 8bpp），不匹配即 throw 带说明的错误——错误信息是承诺层质量的一部分。

### 4.3 raw 层（逃生舱）

- wasm 导出全量 C 符号（`EXPORTED_FUNCTIONS` 由 `gen-exports.mjs` 扫 `allheaders.h` 生成；配套导出 `_malloc/_free`）。
- TS 侧松类型：`(ptr: number, ...args: number[]) => number`；零所有权语义，文档标注危险区。
- 无 semver 承诺，leptonica 符号名即 API。
- 默认产物是否含全量导出 → M1 spike 裁决（见 §3 体积控制）。

## 5. Worker 会话客户端

### 5.1 缝合线裁决：builder 即协议

R2/Q3 的两个方案在此合流：

- **API 形态** = builder/录制器（Hoare）：`session.chain(img).toGray().otsu().dilate(3).run()` —— 记录在主线程，`run()` 才发消息，整链一条 wire 消息、一个 await。per-op 逐条 RPC 不作为公共 API。
- **wire 格式** = 可序列化算子描述（Zakai）：builder 录下来的就是 `Op` tagged union 数组，Worker 侧拿数组对同步核心回放。同步核心的 `chain()` 是同一描述的同步执行——两端共享 `src/protocol.ts`，不存在第二套语义。

```ts
// src/protocol.ts（示意）
type Op =
  | { op: 'toGray'; w?: [number, number, number] }
  | { op: 'threshold'; level: number }
  | { op: 'otsu'; tile?: number }
  | { op: 'deskew'; reduction?: number }
  | { op: 'rotate'; angle: number; quality?: 'area' | 'shear' }
  | { op: 'scale'; fx: number; fy?: number }
  | { op: 'clip'; x: number; y: number; w: number; h: number }
  | { op: 'dilate' | 'erode' | 'open' | 'close'; w: number; h: number }
  | { op: 'sobel'; orientation?: 'all' | 'h' | 'v' }
  | { op: 'or' | 'and' | 'xor' | 'blend'; other: HandleId; frac?: number }
  | { op: 'addBorder'; t: number; val?: number }
  // …完整版以实现为准
```

二元算子（or/blend 等）在描述里引用另一个 `HandleId` —— 天然可序列化。

### 5.2 消息协议（手写，两端共用）

```ts
type Req =
  | { id: number; type: 'load';   buffer: ArrayBuffer; w: number; h: number }
  | { id: number; type: 'run';    source: HandleId; ops: Op[] }
  | { id: number; type: 'extract'; handle: HandleId;
      format: 'rgba' | 'png' | 'jpeg'; opts?: EncodeOpts }
  | { id: number; type: 'query';  op: QueryOp; handle: HandleId; args?: unknown }
  | { id: number; type: 'close' };

type Res =
  | { id: number; ok: true;  handle?: HandleId }
  | { id: number; ok: true;  buffer?: ArrayBuffer; meta?: ImageMeta }  // transfer
  | { id: number; ok: true;  value?: QueryValue }
  | { id: number; ok: false; error: string };
```

- 大块数据一律 `postMessage` transfer（load 上行、extract 下行），不做 structured clone。
- 句柄表：Worker 侧 `Map<HandleId, Pix>`，单调递增 ID；v1 无逐对象释放，`close()` 全量 `pixDestroy` + 清表。
- 会话毒化：close 后 Worker 侧 `closed` 标志 + 主线程代理全部抛错；`terminate()` 直接 `worker.terminate()`（进程级回收整堆，永远有效）。
- Worker 侧 run() 执行失败：该次链中已产生的中间 Pix 在返回错误前全部销毁（错误路径也是调用栈内消亡）。

### 5.3 Worker 加载与跨 bundler

- 入口 `dist/worker.mjs`；客户端 `new Worker(new URL('./worker.mjs', import.meta.url), { type: 'module' })`。
- wasm 定位：worker 内 `new URL('./leptonica.wasm', import.meta.url)`；`createSession({ wasmPath })` 允许 CDN/自托管覆盖。
- Node：`typeof Worker === 'undefined'` 时切 `worker_threads`（适配层 ~50 行，tesseract-wasm 先例）。
- 冒烟矩阵：vite / webpack5 / esbuild / Node ESM 各跑一遍 worker 加载（tesseract.js issue 史为鉴，bundler 的 worker+wasm 解析是历史雷区）。

### 5.4 ADR：手写协议，弃用 Comlink

理由：(1) 协议面小且固定（load/run/extract/query/close），Comlink 的通用对象代理能力用不上；(2) `run()` 要一次消息带完整 ops 数组、`extract` 要 transfer 控制权，proxy 语义反而碍事；(3) 少一个依赖。代价 ~100 行协议代码 + 手写类型，接受。

## 6. 类型管线（决策 ⑩）

- 精选层：手写 embind（`cpp/bindings.cpp`）+ Emscripten `--emit-tsd`。
- TS 包装层手写类型；`protocol.ts` 的 `Op` union 即链式 API 的类型源。
- CI 防漂移（`scripts/check-exports.mjs`）：`WebAssembly.Module.exports(new WebAssembly.Module(bytes))` 与 d.ts 声明集 diff——绑定表即清单，C 编译器验证存在性，杜绝「.d.ts 说有、wasm 里没有」。
- raw 层松 d.ts 由 `gen-exports.mjs` 一并生成（名字级，参数 `number`/`any`）。

## 7. 测试与 CI

### 7.1 反自我闭环三原则

1. **独立 oracle**：正确性锚点是同一 pin commit 的**原生 leptonica 构建**（C harness，与 wasm 完全不同的工具链），不是本库自身输出。合成不变量（otsu 双峰等）只作补充，不作正确性证明。
2. **先红后绿**：M4/M5 每个算子先写测试（含 oracle 金样断言）并确认失败，再写 embind 实现；提交历史可见红→绿，评审门抽查。
3. **测试有效性验证**：金样套件必须通过变异冒烟——故意破坏一个参数映射（交换宽高、错枚举值等），测试必须变红，恢复后变绿；防止「绿灯形同虚设」。

### 7.2 测试矩阵

| 层 | 工具 | 内容 |
| --- | --- | --- |
| **oracle 金样比对** | CI 双构建 + C harness | 同 versions.json pin：原生 leptonica（cmake+ninja）与 wasm 各自构建；C harness 解析与 `protocol.ts` 同构的 Op JSON，跑同一批输入与算子链产出金样；wasm 输出必须一致——PNG 逐字节，浮点标量（skew 角度等）容差 |
| 同步核心单测 | vitest (Node) | 合成图像全算子：deskew 角度恢复、otsu 双峰分割、dilate 像素数上界、**1bpp depth 不被抬升**、类型规则 throw、毒化行为（不变量层，补充 oracle） |
| Worker 单测 | vitest (Node, worker_threads) | 协议往返、transfer、close 毒化、terminate 无残留、run() 失败路径清理 |
| 跨环境一致性 | Playwright | 浏览器 vite 页 → worker 链 → PNG 字节 vs Node 输出**逐字节比对**（只证环境一致，不证正确性——正确性由 oracle 承担） |
| 构建防漂移 | GitHub Actions | pin emsdk → wasm 构建 + 原生构建 → check-exports → 全测试 |
| 季度重建 | scheduled workflow | 全量构建 + oracle 比对 + 测试，浮起依赖漂移（决策 ⑪） |

oracle 细则：

- 金样每次 CI 现场再生（同 commit 原生跑出来），不依赖历史 fixture——检测「原生 vs wasm 分叉」，无陈旧问题；发布 tag 时另存金样快照，供依赖升级时 diff 行为变化。
- C harness 消费与 TS 端同构的 `Op` JSON——对 §5.1「描述即契约」本身也是测试。
- 原生构建使用与 wasm 完全相同的 versions.json pin（zlib/libpng/libjpeg-turbo/leptonica），同 zlib 下 PNG 编码应逐字节一致；这是字节级强锚成立的前提。

发布（决策 ⑪）：npm publish 带 provenance；PNG 字节比对为强锚点，浮点标量只比容差。

评审规程：每里程碑落地执行双层评审（trellis-check 硬评审 + dbs-chatroom 多视角评审），findings 分级处置（blocker/warning/nit），SOP 详见 implement.md。

## 8. 体积 spike（首任务，回填 PRD R5）

目的：三个未知数 + 一个裁决——

1. 精选构建（仅 png/jpeg 写路径）产物体积（raw + gzip）。
2. 全量 C ABI 导出的体积增量。
3. 「不暴露 `pixRead` → 解码路径被裁剪」验证（wasm 导出表/符号表无解码入口残留）。
4. 裁决：默认产物 = 精选 or 含全量 raw；core/full 是否拆分。

产出：`research/size-spike.md`，结论回写 PRD 决策 ⑦。

## 9. 兼容性与回滚

- 新包首发 `0.1.0`；semver 只承诺精选层。
- 回滚：npm deprecate / `next` tag 降级；构建永远可复现（versions.json 不动 → 旧产物可重建）。
- Worker 客户端可整体绕开（同步核心 + 用户自管 worker）——承诺层失败不阻塞逃生舱使用。
- 运行时探测失败（如 SIMD 不可用）只降级能力标志，不拒载。

## 10. ADR 简录

| # | 决策 | 一句话理由 |
| --- | --- | --- |
| 1 | ESM-only | worker + wasm 的 URL 解析在 CJS 下不可救；Node 18+ ESM 已普及 |
| 2 | 手写消息协议，不用 Comlink | 协议面小、需 transfer 控制、少一依赖（§5.4） |
| 3 | Op tagged union 为唯一算子语义源 | builder 与 wire 格式合流，同步/Worker 无双轨（§5.1） |
| 4 | 构建编排自写 build.mjs，不用 CMake FetchContent | 与 tesseract-wasm 验证过的路径一致，pin 显式可见 |
| 5 | d.ts 用 --emit-tsd + CI 导出 diff | 拒绝自造 libclang 管线（决策 ⑩） |
| 6 | FINALIZATION_REGISTRY 仅报警 | 毒化 + 显式 dispose 为主，兜底交给 close/terminate（决策 ④） |
