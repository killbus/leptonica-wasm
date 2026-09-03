# Research: tesseract-wasm (robertknight) — Leptonica WASM 构建参考

Repo: `third_party/tesseract-wasm` (depth-1 clone, HEAD a42151c, 2025-10-24). All paths relative to repo root.

## 1. Leptonica 的 WASM 编译方式

- 源码获取：depth-1 clone DanBloomberg/leptonica + fetch pinned commit（`Makefile:79-83`）；版本 pin 在 `third_party_versions.mk:5`。
- 构建：`emcmake cmake -G Ninja` + `emmake ninja install`（`Makefile:85-90`），装到 `$(INSTALL_DIR)`。
- CMake flags（`Makefile:71-77`）：`-DLIBWEBP_SUPPORT=OFF -DOPENJPEG_SUPPORT=OFF`（图像解码下放浏览器，只传 RGBA）+ `-DCMAKE_POLICY_VERSION_MINIMUM=3.5`（Leptonica 1.83.1 cmake 版本太老）。
- **对 leptonica 源码零 patch**（patches/ 只有 tesseract.diff）。
- Leptonica 只构建一次，SIMD/fallback 两个 tesseract 共同链接（`Makefile:186`）。
- **Leptonica 自身没开 `-msimd128`**（只加在 Tesseract 上）——做 leptonica-wasm 要 SIMD 需自己加。

## 2. Emscripten 环境

- emsdk：depth-1 clone + pin commit（`third_party_versions.mk:2`，v3.1.31），但实际 `emsdk install latest`（`Makefile:66-69`）——工具链未精确 pin（痛点）。
- 最终 emcc 链接 flags（`Makefile:153-173`）：
  - `-Os --no-entry -sEXPORT_ES6 -sENVIRONMENT=web -sFILESYSTEM=0 -sMODULARIZE=1 -sALLOW_MEMORY_GROWTH -sMAXIMUM_MEMORY=1GB -std=c++20 -sDYNAMIC_EXECUTION=0 -fexperimental-library --post-js=src/tesseract-init.js`
  - 链接：`emcc src/lib.cpp ... -ltesseract -lleptonica -lembind -o build/tesseract-core.js`

## 3. embind API 面（src/lib.cpp）

- `Image` class（`lib.cpp:103-123`）：构造 `pixCreate(w,h,32)`（强制 32bpp RGBA）；`Data()` 返回 `typed_memory_view`（零拷贝，JS 直接 `view.set()` 写像素）；`Pix()` 裸指针给 Tesseract；析构 `pixDestroy`（RAII，JS 须 `.delete()`）。
- 除此外**不暴露任何原生 Leptonica 函数**；leptonica 仅内部使用（如 `pixOrientDetect`，`lib.cpp:260`）。
- `EMSCRIPTEN_BINDINGS`（`lib.cpp:343-387`）：value_object（IntRect/TextRect/Orientation/OCRResult）、class_（Image/OCREngine）、enum_、register_vector。
- `tesseract-init.js`：WASM 实例化前设 `ENV.DOTPRODUCT="sse"`（SIMD 探测用 30 字节 mini-wasm + `WebAssembly.validate`）。

## 4. TS wrapper（双层 API）

- 低层 `OCREngine`（同步，直接 embind）+ 高层 `OCRClient`（async，Comlink RPC 到 Worker）。
- `createOCREngine` 无 `wasmBinary` 时按 SIMD 探测选 `tesseract-core.wasm` / `tesseract-core-fallback.wasm`，`import.meta.url` 解析相对路径（`ocr-engine.ts:383-401`）。
- Worker：`comlink.expose`；Node 走 `node:worker_threads` + comlink node-adapter（`node-worker.js`）。
- 进度走独立 MessageChannel（规避 comlink.proxy 的低效和 Firefox bug，`ocr-client.ts:80-94`）。

## 5. 打包

- rollup 两个 build：`src/worker.ts` → UMD（Firefox/Safari<15 不支持 module workers）；`src/index.ts` → ESM。
- dist：两个 .wasm + lib.js + tesseract-worker.js；`.d.ts` 由 tsc 产出。
- package.json：`"type": "module"`，exports `.` 和 `./node`；deps 仅 comlink。
- 用户需自行 hosting 静态 wasm/worker 文件。

## 6. SIMD/fallback 双构建

- 主版 `-DHAVE_SSE4_1=ON -msimd128`；fallback 无 SIMD 独立安装前缀；fallback 只取 .wasm，JS wrapper 复用主版。
- 运行时 `WebAssembly.validate(30字节SIMD探测wasm)` 选择。

## 7. CI

- PR 触发，ubuntu-24.04：`make lib` → typecheck → checkformat → test（`ci.yml`）。
- 痛点：`make examples` 无对应 Makefile target（workflow 与 Makefile 脱节）；Node 版本未 pin；无发布 workflow（本地 np）。

## 8. 测试

- mocha + sharp（宿主侧解码图像→RGBA ImageData）；tessdata_fast depth-1 clone。
- 方向检测测试间接测了 `pixOrientDetect`（0/90/180/270 全判对）。
- **无任何 Leptonica 直接单测**；进度测试有 for-in 死代码 bug。

## 9. 版本 pin

`third_party_versions.mk`：EMSDK v3.1.31、Leptonica v1.83.1、Tesseract v5.3.0。

## 值得借鉴 / 痛点

借鉴：体积策略（-Os + FILESYSTEM=0 + 裁剪 + RGBA 直传 typed_memory_view）；fallback 只发 .wasm；DYNAMIC_EXECUTION=0（CSP 友好）；双 API 分层 + Comlink + 独立进度 channel；版本 pin 集中一个文件；wasmBinary 注入。

痛点：emsdk 未真 pin（install latest）；patch 用 git stash/apply 脆弱；无 wasm-opt 后处理；CI 已脱节；Leptonica 未开 SIMD；输入强制 32bpp RGBA。
