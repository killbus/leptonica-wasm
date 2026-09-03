# Modern WASM build of Leptonica

## Goal

将 Leptonica（C 图像处理库）以现代工程实践编译为 WebAssembly，在本仓库（leptonica-wasm）产出可发布、可维护的 WASM 版本及配套开发体验（API 绑定、类型、打包、CI、测试）。

## Background

- 本仓库当前为空仓库（仅 Trellis 脚手架），尚不是 git 仓库。
- 参考仓库（已 depth-1 clone 于 `third_party/`，不纳入版本跟踪）：
  - `tesseract-wasm`（robertknight）：Emscripten + CMake/Ninja 编译 leptonica+tesseract，embind 绑定，SIMD 双版本，rollup TS 封装。Leptonica 构建零 patch、关 webp/openjpeg、32bpp RGBA 输入。
  - `liteparse`（run-llama）：Rust/wasm-bindgen 路线，预编译 C 库（WASI SDK）+ sys crate 消费 + 两层 WASI shim + wasm-pack 三 target + tsify 类型 + Playwright/Miniflare E2E CI。
- 详细调研见 `research-tesseract-wasm.md`、`research-liteparse.md`。
- 交付形态与架构经 dbs-chatroom 专家讨论（五轮：Zakai / Hoare / Hickey / Luu）收敛，结论见 Technical Decisions。

## Confirmed Facts

- 用户要求：third_party 参考仓库用 depth-1 clone，不 track。
- 交付形态已决策：薄 A 路线（Emscripten + embind + 薄 TS 封装），排除 Rust/wasm-bindgen 与「仅构建管线」路线。
- 消费者画像已决策：通用图像算子用户（非 OCR 管线；TIFF/G4 等特殊需求走 raw 层）。
- 编码输出已决策：需要（canvas.toBlob 参数不可控、编不出 1bpp PNG），故 codecs 进核心。

## Technical Decisions（专家讨论第 1–5 轮收敛）

### 交付与 API 架构

1. 交付形态：薄 A 路线 —— Emscripten + embind + 薄 TypeScript 封装（tesseract-wasm 同路线）。
2. API 结构：双层 —— raw 层暴露全量 embind 绑定作逃生舱（事实层，无 semver 承诺，文档标注危险区）；承诺层为精选 API（观点层，唯一公开承诺，用户可整体绕开）。「生成签名，手写所有权」。
3. 边界协议：RGBA 像素数据只在边缘（输入/输出）进出；链上传 Pix 句柄，不搬像素。RGBA 是边界格式不是中间格式（1bpp 语义保持、内存 32 倍差距）。
4. 同步核心的 Pix 生命周期：显式 free + Symbol.dispose + 句柄毒化；FinalizationRegistry 仅作泄漏报警，不承担释放语义（回调可能永不执行，不能当兜底）。
5. 精选层入口 fromRGBA（32bpp）、出口显式 toRGBA/toPNG；pixRead 不进精选层（解码交给浏览器 createImageBitmap/decode）。

### 编解码与构建

6. 编解码：PNG + JPEG 写入进承诺层（证据：jsquash / wasm-vips / tesseract.js，operator 与 encoder 都在 wasm 是严肃图像工具的默认架构）；TIFF 延后至真实用户出现；TIFF/G4 需求走 raw 层。
7. 构建：单构建起步；codecs 为构建期开关（CMake flag）而非发布矩阵。**已裁决（2026-09-03，M1 size spike 数据回填）**：精选模式为默认产物（wasm 406KB / gzip 105KB），全量 C ABI 为逃生舱层（2.59MB / gzip 856KB，2745 函数导出）——gzip 增量 ~750KB（8 倍）远超 ~100KB 阈值，全量导出对默认消费者不可接受；「按读/写方向切」的 escape hatch 不需要（精选模式已天然只含写侧 + 无解码入口）。对照混入 -O2/-O3 变量（full-abi 保导出名降优化级别），量级结论稳健，精确数字 M2 同优化级别复核。证据：`research-size-spike.md`，CI run 33767637278。
8. 无 pthread / SAB / COOP-COEP（Leptonica 有全局状态非线程安全，一 Worker 一实例本来就是安全模型）；图片级并发 = 多实例 Worker，transfer ArrayBuffer。
9. SIMD：不做构建变体（主流浏览器均已支持），运行时 WebAssembly.validate 探测。
10. 类型管线：精选层手写 embind + Emscripten `--emit-tsd` 生成 d.ts；CI 用 `WebAssembly.Module.exports()` / `wasm-objdump -x` diff 实际导出防漂移；不上 doxygen XML、不自造 libclang 生成器。
11. 激进冻结（维护承诺）：emsdk 精确 pin（吸取 tesseract-wasm 装 latest 的教训）、leptonica 与依赖 pin 到 commit/版本；每季度从头重建流程；真实浏览器 E2E smoke（Playwright）。

### 执行模型与会话

12. 执行模型「C 的核，A 的壳」：同步核心为一等公民（Node / 已在 Worker 内的用户直接用）；Worker 会话客户端 —— Pix 句柄驻留 Worker、消息只传句柄 ID + 参数、像素不跨界、大输出用 ArrayBuffer transfer 送回。文档与示例以 Worker 客户端为主入口（opencv.js「卡死 UI」骂声、onnxruntime-web 后补 wasm.proxy 的教训）。
13. 承诺层 API 形状：builder / 链录制器方向（记链、一次 run()、恰好一个 await，std::process::Command 形状）；per-op RPC 作为会话内退化形态。缝合线具体裁决在 design.md。
14. 会话内 Pix 死亡归属（竞技场模型；证据：ND4J workspace / OneDNN scratchpad 成功先例，embind 逐对象 delete() / onnxruntime-web 显式 dispose 翻车先例）：
    - `session.close()` 一次释放全部驻留 Pix，是唯一生命周期契约。
    - 链的中间 Pix 在单次 `run()` 调用栈内生灭，从不跨消息边界，无需协议。
    - 跨消息边界存活的只有两类、少数句柄：用户输入的源 Pix、持取的最终结果 Pix。
    - 提取即终点：toRGBA/toPNG 返回字节而非所有权；用户要的是字节，不是 Pix。
    - v1 不做逐对象远程 dispose / asyncDispose（长会话内存压力未证实；缓解手段：提取即终点、重开会话；真实压力出现再加可选优化）。
    - Worker 被终止或页面关闭：整个 WASM 堆随 Worker 进程死亡被回收，泄漏上限 = 会话寿命（唯一不依赖任何人的兜底）。

## Requirements

### R1 构建管线
- Emscripten（emsdk 精确 pin）编译 leptonica + libpng + libjpeg（+zlib），CMake，零 patch 源码（参考 tesseract-wasm 的 CMake flag 组合与 third_party_versions.mk pin 方式）。
- 产物：单 .wasm + JS glue，含 png/jpeg 写路径；因 pixRead 不暴露，解码路径应被链接器裁剪（验证性任务，见 R5）。
- 所有依赖 pin 到 commit/版本，构建可复现。

### R2 API（双层）
- raw 层：embind 全量导出（逃生舱，危险区文档标注，无 semver 承诺）。
- 承诺层：Pix 句柄（Symbol.dispose / 毒化）+ fromRGBA / toRGBA / toPNG + 精选算子（清单见下）+ builder/链式形态。
- d.ts 由 `--emit-tsd` 产出，CI 导出表 diff 防漂移。

承诺层 v0.1 算子清单（用户已确认全选，基础设施 = fromRGBA/toRGBA/toPNG + 灰度/位深转换，默认包含）：

| 类别 | 候选 Leptonica 函数（design.md 敲定终版） |
| --- | --- |
| 二值化/阈值 | pixThresholdToBinary、pixOtsuAdaptiveThreshold、pixSauvolaBinaConstant |
| 版面矫正 | pixFindSkew、pixDeskew |
| 几何变换 | pixRotate、pixScale、pixHShear/VShear、pixClipRectangle、pixTranslate |
| 形态学 | pixDilate/Erode/Open/Close（Sel 由 brick 参数构造，DWA 快速路径优先） |
| 连通域分析 | pixConnComp → boxa（返回 Box[]） |
| 统计/直方图 | pixCountPixels、pixGetGrayHistogram、pixGetAverage |
| 边缘/梯度 | pixSobelEdgeFilter |
| 区域组合 | pixOr/And/Xor（1bpp）、pixAddBorder(s)、pixBlend |

### R3 Worker 会话客户端
- 同步核心之上的机械包装（约百行 + CI 冒烟）：句柄驻留、消息传 ID + 参数、大输出 transfer、session.close() 竞技场释放。
- 跨 bundler 的 worker + wasm 路径解析要测试（tesseract.js issue 史为鉴）。
- Node 侧 worker_threads 适配参考 tesseract-wasm 先例。

### R4 质量与发布
- 单元测试（Node，同步核心直测）+ 浏览器 E2E smoke（Playwright：Worker 客户端加载 wasm → RGBA 输入 → 链执行 → PNG 字节输出）。
- 正确性锚点独立于本库：同一 pin commit 的**原生 leptonica 构建**（C harness 跑同一批算子链）作为 oracle，wasm 输出与原生金样比对——防止「实现与测试同源」的自我闭环。
- 测试先行：精选层算子先写含金样断言的失败测试（红），再写实现（绿），提交历史可查。
- npm 发布管线（provenance 参考 liteparse）。
- 季度重建流程文档化。

### R5 首个验证任务（体积 spike）
- 测量单构建产物体积；验证「不暴露 pixRead 则解码路径被裁剪」假设；回填 core/full 拆分决策。

## Acceptance Criteria

- [ ] 从零环境（干净机器 + pinned emsdk）一条命令完成构建，产物可复现。
- [ ] Node 单测：fromRGBA → 灰度 → 二值化 → 形态学 → toRGBA/toPNG 全链通过，1bpp 语义在链上保持（不被抬成 32bpp）。
- [ ] Playwright 浏览器 E2E：Worker 客户端加载 wasm → RGBA 输入 → 链执行 → PNG 字节输出，与 Node 侧输出逐字节一致（环境一致性；语义正确性由 oracle 承担）。
- [ ] oracle 比对：CI 同 commit 双构建（原生 + wasm，versions.json 同 pin），同一批输入与算子链，wasm 输出与原生金样一致（PNG 逐字节、浮点标量容差）；金样套件通过变异冒烟（故意破坏一个参数映射，测试必须变红）。
- [ ] session.close() 后再调用任何会话方法抛错（毒化验证）；Worker terminate 后无残留（进程级验证）。
- [ ] d.ts 导出的每个符号在 wasm 实际导出表中存在（CI diff 通过）；raw 层全量导出可被 import。
- [x] 体积 spike 报告落盘（产物体积、解码路径裁剪验证、core/full 裁决建议）。——`research-size-spike.md` 全部收口：双模式体积 + 确定性 + `pixRead*` 缺席 + 裁决建议已回填（M1，2026-09-03）
- [ ] npm 包 dry-run 可安装，Node 与浏览器双端 smoke 通过。

## Out of Scope（v0.2+ 候选）

- demo site（用户裁决：延后到 v0.2）。
- TIFF 读写（延后至真实用户出现；需求走 raw 层）。
- 逐对象远程 dispose / asyncDispose（等真实长会话内存压力证据）。

## Open Questions

1. builder/链录制器 vs per-op 会话：缝合线具体设计（design.md 展开）。
