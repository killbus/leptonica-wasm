# Journal - killbus (Part 1)

> AI development session journal
> Started: 2026-09-03

---

## 2026-09-03 M1 CI 首跑失败修复（TEAM C）

- CI run 33735115539 失败于 "Build (default, cold)"：`class_<PIX>` 编译错误——embind 的 `class_` 模板对 `typeid(Pix)`（wire.h LightTypeID）和 raw destructor（`delete ptr`）都要求完整类型，而 `allheaders.h` 只有 `struct Pix` 前向声明。
- 根因链：完整定义在 `pix_internal.h`（leptonica 内部头，自述 "can be #included after allheaders.h"，`bmf.c:74-75` 为官方组合先例）；该头不随 `make install` 安装。
- 修复：`cpp/bindings.cpp` 在 `allheaders.h` 后加 `#include "pix_internal.h"`；`build.mjs` emcc 参数补 `-I tmp/deps/leptonica/src`。
- Push 卫生：按用户指示（语义不变的实现修复），fixup 进 `12ce162` → autosquash rebase → `--force-with-lease` push 为 `599abcc`，不堆叠修复 commit。
- 本机 vitest 失败（node v24/win32，`Cannot read properties of undefined (reading 'config')`）经 stash 对照与 CI 日志对照确认是本地环境特有，CI（node 20/ubuntu）同 commit 测试绿——不阻塞，符合零编译纪律（运行时行为以 CI 为准）。
- 重跑：run 33743439895 已触发，监控中。
- run 33743439895 二次失败于链接：`emcc` 驱动 C 链接不含 libc++/libc++abi，`class_<PIX>` 的 typeid/RTTI 符号（`__cxxabiv1::__class_type_info`、`operator delete`）未定义。修复：`build.mjs` 链接器改 `em++`；顺带移除 `-sWASM_BIGINT=1`（emsdk 6.0.9 已废弃该开关，纯警告噪音）。
- 同样 fixup 进 M1 commit → `d824f30` force push → 第三次 run 33744418718 触发，监控中。
- run 33744418718 三次失败于 "Smoke test (default)"：断言 `symbol map should contain pixWriteMemPng` 红。构建本身全绿（双次构建 sha256 稳定 `f5b64575…`，PNG/JPEG/toRGBA 字节级断言全过）。
- 根因分析（读 emsdk pin 版源码 `emscripten-building.py:1162` 确认）：`--emit-symbol-map` 从最终 wasm 的 name section 读函数名；-O3 下 Binaryen 把单一调用点的 `pixWriteMemPng` 内联进 embind 包装，独立函数体被消除 → 名字合法消失。编码器在场已由字节级断言证明（PNG IHDR / JPEG SOI 逐项过），编码核心符号（`png_write_*` ×13、`jpeg_*` ×44）均在。
- 修复：断言收窄——`smoke.mjs` 删 `pixWriteMemPng` 名字在场断言（附注释说明内联成因），保留 load-bearing 的 `pixRead*` 缺席断言；`research-size-spike.md` §验证 同步记录该裁决与证据（run 号留档）。
- fixup → `483dbc5` force push → 第四次 run 33747019976 触发，监控中。
- run 33747019976 四次失败于 "Smoke test (full ABI)"：`full-abi wasm should export pixReadMemPng`。default 链路（双构建 + 冒烟）已全绿——只差 full-abi 冒烟。
- 根因（读 emsdk pin 版 `emscripten-link.py:1611-1636` 确认）：-O3 + JS 输出让 binaryen 启用 `MINIFY_WASM_IMPORTS_AND_EXPORTS`，wasm 导出名被压缩为 `da, ea, fa…`（2752 个导出、0 个 `pix*`，但 symbol map 3727 项里 `pixReadMemPng` 在 id 1723）。raw C ABI 逃生舱需要真名。
- 修复：`build.mjs` full-abi 分支加 `-sMINIFY_WASM_EXPORT_NAMES=0`（default 模式不加——embind 包装已吃掉导出面，体积优先；full-abi 才是 C ABI 消费者）。
- fixup → `18e0af9` force push → 第五次 run 33750787506 触发，监控中。
- run 33750787506 五次失败于 "Build (full ABI)"：`em++: error: MINIFY_WASM_EXPORT_NAMES is an internal setting and cannot be set from command line`——上一轮选的开关是内部设置，CLI 不可设。
- 重新分析（读 `emscripten-link.py` will_metadce + `emscripten-building.py:935` minify 函数）：导出名压缩的启用门是 metadce 链（`OPT>=3 或 SHRINK>=1` + 其余条件）且 `MINIFY_WASM_EXPORT_NAMES` 默认 1、无公开开关。唯一干净 CLI 杠杆是关掉 metadce——**full-abi 用 `-O2`**（OPT2/SHRINK0 → metadce 不跑 → 导出名保留）。代价：full-abi 体积测量从 -O3 降为 -O2，与 default(-O3) 的对照混入优化级别变量——已注释说明，M2 可用后链接重命名（symbol map 可逆映射） revisit。
- fixup → `ff86f5b` force push → 第六次 run 33754958056 触发，监控中。
- run 33754958056 六次失败于 "Smoke test (full ABI)"：`should not export pixReadMemWebP` 红——导出表里该名字**在场**。根因：leptonica `src/CMakeLists.txt` 用 `file(GLOB src "*.c")` 全量编译，`ENABLE_WEBP=OFF` 下 `webpio.c` 实现被 `HAVE_LIBWEBP` 守卫清空，但 `webpiostub.c` 提供同名错误桩（返回 NULL "function not present"）；gen-exports 的"声明 ∩ 归档定义"正确含入该桩。真实判据应为**解码器符号**（`WebP*`）缺席而非桩名缺席——实测 0 个。修 smoke 断言（default 模式断言不受影响：符号表 `pixRead*` 0 项，桩没被链进 default）。
- fixup → `343a6cd` force push → **第七次 run 33767637278 全绿**（全部 step 绿）。
- 数据回填：default 406KB/105KB gzip (93.8s cold)；full-abi 2.59MB/856KB gzip (2745 导出, 5.8s 复用依赖)；双构建 sha256 稳定 `f5b64575…`；冒烟全过。
- 裁决：**精选为默认产物、full-abi 逃生舱**（gzip 增量 ~750KB 远超 100KB 阈值）——回填 PRD 决策 ⑦ + research-size-spike.md 结果/结论 + implement.md M1 第 4/5/6 项勾选。M1 清单全部完成，进评审门。

