# Research: liteparse (run-llama) — 现代 WASM 工程化参考

Repo: `third_party/liteparse` (depth-1 clone). LiteParse = PDF 解析（PDFium）+ OCR 插件。**注意：leptonica 在此仓库只是 tesseract 的 native 系统依赖，从未被编译进 wasm**——本仓库提供的是「机制」而非目标库先例。

## 1. Workspace 布局

- Rust workspace，edition 2024，6 members：`pdfium-sys`（FFI + 预编译二进制获取，`links="pdfium"`）、`pdfium`（safe wrapper）、`liteparse`（核心）、`liteparse-wasm`（薄 wasm-bindgen cdylib，全 crate `#![cfg(target_arch="wasm32")]`）、`liteparse-napi`、`liteparse-python`。
- 外围：`packages/wasm`（npm 包装）、`wasm-demo-site`（单文件零构建）、`ocr/`（HTTP OCR server 参考）、`scripts/`。
- 模式：C 引擎隔离在 sys crate 后面，wasm crate 零业务逻辑，只有 API 面和 wasm shim。

## 2. WASM 构建工具

- wasm-pack，目标 `wasm32-unknown-unknown`（freestanding，运行时无 WASI；PDFium 是 WASI 编译后重链接进 freestanding 模块）。
- Rust pin 1.95.0（`ci-wasm.yml:39`）；`wasm-opt=["-O3"]` 经 `[package.metadata.wasm-pack.profile.release]`。
- 三 target 一 crate：`--target web` / `bundler` / `nodejs`（`packages/wasm/package.json:22-24`），build 后跑 `scripts/patch-wasi-imports.js`。
- deps：wasm-bindgen-futures、serde-wasm-bindgen、tsify-next（生成 .d.ts）。
- API 设计：`#[wasm_bindgen(start)]` panic hook；tsify 派生类型；`typescript_custom_section` 手写 TS 补充；camelCase js_name；**有界内存 session API（openBatchSession/nextBatch/free()）**。

## 3. C 库集成（PDFium）— 核心可迁移

- 预编译获取（`pdfium-sys/build.rs`）：release tag `chromium/8028`，优先级 env vars → `vendor/` → 自动下载到 `~/.cache/pdfium-rs/`。
- wasm 链接行：静态 `pdfium, c, c++, c++abi, wasi-emulated-mman, wasi-emulated-signal` + 条件 `setjmp`。
- native 侧相反：libloading 运行时 dlopen。
- bindgen 可选，默认用 committed `bindings.rs`（CI 无需 libclang）。
- **两层 WASI shim**：
  - Rust 侧 stub（`wasi_stubs.rs`）：getpid、pthread_mutex_*、SjLj 的 `__wasm_setjmp/__wasm_longjmp`（`__c_longjmp` 是 WebAssembly.Tag）。
  - JS 侧 post-build patch（`patch-wasi-imports.js`）：注入 `__wasi_stubs`（真实 errno、fd_write→console.warn、fail-loud 防布局漂移）。
- **SjLj 剧本**：libsetjmp.a 与 Rust codegen 的同名符号冲突，用 `--allow-multiple-definition`（从最终 cdylib 的 build.rs 发出，rustc-link-arg 不跨 crate 传播）+ `cfg(have_libsetjmp)` 条件 stub。

### Producer 侧（pdfium-binaries fork，branch llamaparse）

- GitHub Actions：WASI SDK 24（官方 release），`clang --target=wasm32-wasi --sysroot=$WASI_SYSROOT`。
- **stage 时随包附带 WASI runtime libs**（libc.a/libc++.a/libc++abi.a/libwasi-emulated-*.a/libsetjmp.a）——否则消费方在 freestanding target 出现 `env::` 未解析导入。
- `libsetjmp.a` 专为 `-mllvm -wasm-enable-sjlj` 编译的代码（libjpeg 的 error handler 就是这个 case——**对 leptonica 直接相关**）。
- 产物 `pdfium-wasi-wasm.tgz`，tag `chromium/<rev>`，liteparse pin `chromium/8028`。
- 上游 fork patch 纪律：API 增加以 `patches/llamaparse/*.patch` 在 CI 应用，包括批量 FFI 入口（减少每字符 round-trip）。

## 4. OCR 接线

- wasm 里不编任何 OCR 引擎；wasm OCR = JS 回调（`JsOcrEngine`，PNG 字节契约而非裸像素）。
- `OcrEngine` trait 双定义：native 要求 Send+Sync，wasm32 放宽。
- leptonica 仅作为 tesseract 的 native 系统依赖出现在各 CI workflow 的 apt/brew/yum/apk 安装里。

## 5. npm 打包

- `@llamaindex/liteparse-wasm`，`type: module`，exports 含 `./liteparse_wasm_bg.wasm` 子路径（供 initSync）；`pkg/` 是 wasm-pack 输出不提交。
- 发布 CI-only：`npm publish --provenance --ignore-scripts`，版本校验 job，beta/dry-run 输入，git tag + GitHub Release。

## 6. Demo site

- 单 index.html，零构建，直接从 CDN 加载已发布 npm 包（dogfood）。Pages 按路径过滤部署。

## 7. CI/CD

- `ci-wasm.yml` 3 job 分离：build（pin 工具链 + wasm-pack，缓存 C 库下载目录，上传 pkg/ artifact）→ browser-test（Playwright 真实 Chromium，COOP/COEP，端到端 PDF + OCR 回调契约断言）→ edge-test（Miniflare pinned，ESM import wasm + initSync）。
- path filters 让 wasm CI 不阻塞 native CI。

## 8. 对 leptonica-wasm 最可迁移的实践（按价值排序）

1. 预编译 C 库静态 archive 放专门 binaries repo（WASI SDK 构建），env → vendor → 缓存自动下载
2. `links=` + `DEP_*_LIB_PATH` 元数据传递库位置
3. 两层 WASI shim（Rust env stub + JS glue patch，fail-loud）
4. SjLj 剧本（libjpeg error handler = leptonica 强依赖 libjpeg 的直接坑）
5. committed bindgen 绑定（CI 无 libclang）
6. DX：三 wasm-pack target、wasm-opt -O3、tsify 类型、panic hook、.wasm 子路径 export
7. 有界内存 session API（显式 free）
8. CI 深度：pin 工具链、artifact 传递、Playwright + Miniflare E2E、npm provenance
9. 零构建 CDN demo site
