# size spike 研究（M1）

> 命名偏差：design.md §8 与 implement.md 原指定产物名为 `research/size-spike.md`；实际落盘为本任务目录下的扁平文件 `research-size-spike.md`，与既有 `research-vendor-pins.md` / `research-tesseract-wasm.md` / `research-liteparse.md` 的扁平命名约定一致。design.md §8 与 implement.md M1 清单已于 M1 评审（trellis-check）同步为扁平名。

## 目标

- 量化精选 5 函数 API（fromRGBA / toGray / toPNG / toJPEG / toRGBA）的 wasm 产物体积（raw + gzip）。
- 量化全量 C ABI 导出（full-abi 模式）相对精选模式的体积增量。
- 验证精选模式不暴露 pixRead\*（解码路径被链接期裁剪）、full-abi 模式按实际定义过滤后的导出表可用。
- 为 PRD 决策 ⑦（默认产物形态：精选 vs 全量）提供数据，结论回写 PRD。

## 方法

### 依赖版本与获取

- 四个依赖的 commit pin 全部来自 `vendor/versions.json`（zlib v1.3.2、libpng v1.6.58、libjpeg-turbo 3.2.0、leptonica 1.87.0，均 pin 到 commit SHA）。
- 源码经 `https://codeload.github.com/<slug>/tar.gz/<commit>` 获取（commit 级寻址，不可变），落 `tmp/downloads/<name>-<commit>.tar.gz`，`tar --strip-components=1` 解压到 `tmp/deps/<name>/`。
- 幂等性：`tmp/deps/<name>/.pin-commit` 标记 + `CMakeLists.txt` 存在性检查，命中则跳过下载/解压；`tmp/build/<name>/.done` 标记跳过重复编译。
- 编译树与安装前缀分离：`tmp/build/<name>/`（Ninja）与 `tmp/build/install/`（`CMAKE_INSTALL_PREFIX`），不污染仓库。

### 各依赖 CMake 配置

- 公共：`emcmake cmake -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=<install> -DCMAKE_PREFIX_PATH=<install>`。`CMAKE_POLICY_VERSION_MINIMUM=3.5` 原为预置防御 flag（CMake 4.x 移除 <3.5 兼容的官方逃生阀）；M1 评审复核（2026-09-04）：四个依赖树内全部声明 ≥3.10（zlib `3.12...3.31` / libpng `3.14...4.2` / libjpeg-turbo `3.15...3.28` / leptonica `3.10`），无任何 <3.5 声明，该 flag 必要性未复现——**已于 M2 移除**（build.mjs，评审 build-eng N1），移除后四依赖冷配置由携带该变更的 ci run 验证。
- zlib：`-DZLIB_BUILD_SHARED=OFF -DZLIB_BUILD_TESTING=OFF`。
- libpng：`-DPNG_SHARED=OFF -DPNG_STATIC=ON -DPNG_TESTS=OFF -DPNG_TOOLS=OFF` + 显式 `ZLIB_LIBRARY` / `ZLIB_INCLUDE_DIR` 指向安装前缀。
- libjpeg-turbo：`-DWITH_SIMD=OFF`（SIMD 汇编只覆盖 x86/ARM 原生目标，wasm 不可用）+ `-DENABLE_SHARED=OFF`。
- leptonica：`-DENABLE_WEBP=OFF -DENABLE_OPENJPEG=OFF -DENABLE_GIF=OFF -DENABLE_TIFF=OFF` + 六个预置变量（`PNG_LIBRARY` / `PNG_PNG_INCLUDE_DIR` / `ZLIB_LIBRARY` / `ZLIB_INCLUDE_DIR` / `JPEG_LIBRARY` / `JPEG_INCLUDE_DIR`），避免 CMake 探测到宿主机库。
- UNIX 平台判定下 libpng 静态库命名为 `libpng16.a`（链接时 `-lpng16`）。

### bindings 关键决策

- 像素字约定 `0xRRGGBBAA`（MSB=R）。小端宿主上其规范内存序是 [A,B,G,R]，与 JS 侧 RGBA 字节序相反：fromRGBA 将 JS 的 [R,G,B,A] 原样写入后调用 `pixEndianByteSwap` 归一化；toRGBA 直接从字值数值移位取 R/G/B/A（`>>24` / `>>16&0xff` / `>>8&0xff` / `&0xff`）。
- `pixSetSpp(pix, 4)`：leptonica 对 32bpp 新建（`pixCreateNoInit`）默认 spp=3，PNG 写出会选颜色类型 2（RGB）；显式设 4 后 pngio 选颜色类型 6（RGBA）。
- `typed_memory_view<unsigned char>`（emscripten::val）让 JS 拿到真实 Uint8Array 视图；`.call<void>("set", data)` 即 `TypedArray.prototype.set`。
- `allow_raw_pointers()` 注册裸指针签名；`class_<PIX>("Pix")` 以不透明句柄暴露。
- 16MP 守卫：`w > 0x00ffffff / h`（w·h ≤ 0x00ffffff）拦截尺寸溢出。
- M1 有意简化：`toPNG`/`toJPEG` 的编码器输出缓冲与 `toRGBA` 的 `lept_calloc` 缓冲均不释放（逐次泄漏换正确性，view 生命周期依赖该缓冲；M2 承诺层 API 需显式 release/free 设计），失败路径 `lept_free` 兜底。
- `pix_internal.h` 内部头引入：`class_<PIX>` 的 typeid/RTTI 要求 `struct Pix` 完整类型，定义在 leptonica 内部头（`allheaders.h` 之后包含，`bmf.c` 官方先例；`make install` 不装该头，故 `-I` 指向源码树）。CI run 33735115539。
- 链接驱动 `em++`（非 `emcc`）：class_<PIX> 的 `__cxxabiv1` RTTI 符号需要 libc++/libc++abi，C 驱动链接留下未定义符号。CI run 33743439895。

### 链接

- 公共 flags：`--no-entry -lembind --emit-symbol-map --emit-tsd=<out>/leptonica.d.ts -sMODULARIZE=1 -sEXPORT_ES6=1 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=33554432 -sENVIRONMENT=web,worker,node`；优化级别按模式分（见下）。`-sWASM_BIGINT=1` 初版曾带，emsdk 6.0.9 已废弃（CI 警告 "no longer needed"），已移除。
- default 模式：**`-O3`** + 普通 `-lleptonica -lpng16 -ljpeg -lz`（归档语义），链接器函数级 GC 裁掉未引用代码 → 解码路径不进产物。
- full-abi 模式：**`-O2`**（非 -O3）+ `-Wl,--whole-archive -lleptonica -Wl,--no-whole-archive` + `-sEXPORTED_FUNCTIONS=@<abs>`；导出表缺失符号即链接硬报错。-O2 原因（2026-09-03 CI run 33750787506/33754958056 迭代发现）：-O3 下 metadce 链启用 wasm 导出名压缩（`da, ea, …`），而 `MINIFY_WASM_EXPORT_NAMES` 是内部设置不可从 CLI 关闭；raw C ABI 需要真名，唯一干净 CLI 杠杆是把优化级别降到 -O2 关掉 metadce。代价：full-abi 体积测量混入优化级别变量（-O2 vs default 的 -O3）——对照解读时须注意，M2 可用 post-link 重命名（symbol map 可逆映射）回到 -O3 后 revisit。
- 导出表生成：allheaders.h 提取（`LEPT_DLL extern` 声明）∩ `emnm --defined-only`（libleptonica.a 实际定义）+ `_malloc` / `_free`，排序落 `tmp/build/full-abi-exports.txt`。交集过滤排除未编译的编解码器（如 `pixReadMemWebP`，WebP 已禁用）。
- 不加 `-lm`（wasm 目标下 emscripten 自带 math 实现，链接系统库无意义）；M1 不加 `-sFILESYSTEM=0`（留 M2 裁剪）。

### 已知项（主会话预审，M2 处置）

- 依赖 tarball 仅 commit pin、无 sha256 校验（`codeload.github.com` commit 级寻址本身不可变，供应链风险低；M2 供应链防线可加 sha256 白名单）。
- `-sFILESYSTEM` 未关（体积小项，随 M2 裁剪）。

### 验证

- 产物旁 `.symbols` 符号表（`--emit-symbol-map`）做 name-section 级检查：default 模式不含任何 `pixRead\*`；同时检查 `WebAssembly.Module.exports` 无 `pixRead` / `pixWrite` 导出。（初版还断言 `pixWriteMemPng` 名字在场——实测 -O3 将单一调用点的 wrapper 内联进 embind 包装后该名从 name section 消失，属合法优化；编码器在场已由字节级断言证明，断言已收窄。2026-09-03，CI run 33744418718。）
- 冒烟：64×64 渐变图 → PNG IHDR 逐项断言（签名 / 宽高 / 位深 8 / 颜色类型 6）、灰度 PNG（位深 8 / 颜色类型 0）、JPEG SOI（`ff d8`）、toRGBA 字节级往返、负向用例（非法 quality、非法宽高、短缓冲、灰度图 toRGBA 返回 null）。
- full-abi 冒烟：`pixReadMemPng` / `pixReadMemJpeg` / `malloc` / `free` 在 wasm 导出表中、无真实 `WebP*` 解码符号。（初版断言 `pixReadMemWebP` 缺席——实测该符号**在场**：leptonica `src/CMakeLists.txt` 用 `file(GLOB src "*.c")` 全量编译，WebP 关闭时 `webpiostub.c` 提供同名错误桩（返回 NULL "function not present"），`webpio.c` 实现整体被 `HAVE_LIBWEBP` 守卫掉；故 gen-exports 的"声明∩定义"交集正确含入该桩。真实判据是解码器符号缺席（`WebP*` 计 0），非桩名缺席。2026-09-03，CI run 33754958056。）
- 确定性：CI 中双次从零构建（第二次 `rm -rf dist tmp/build`）比对 `wasmSha256` 一致。

## 结果

CI run `33767637278`（commit `343a6cd`，2026-09-03，全部 step 绿；数据源 dist artifact `build-report.json`）：

| mode | wasm bytes | wasm gzip bytes | js bytes | wall (s) |
| --- | ---: | ---: | ---: | ---: |
| default (-O3) | 406,460 | 107,970 (~105.4KB) | 45,839 | 93.8 |
| full-abi (-O2, 2745 导出) | 2,588,792 | 875,942 (~855.4KB) | 376,473 | 5.8 |

- **确定性**：双次从零构建 sha256 一致（`f5b64575…`，wasm 完全可复现）。
- **冷/热构建**：cold 93.8s（含四依赖全量编译）；full-abi 复用依赖产物仅重链 5.8s（依赖缓存有效性证据，供 M2 缓存分层设计）。
- **对照混入变量**：full-abi 为 -O2（导出名保留裁决，见 §链接），default 为 -O3；gzip 增量含优化级别差。同优化级别对照待 M2 revisit。
- 双模式冒烟全绿：PNG IHDR 逐项、灰度 PNG、JPEG SOI、toRGBA 字节级往返、负向用例；full-abi 真实 `WebP*` 解码符号 0 个。

## 结论

**裁决：精选（default）为默认产物，full-abi 作为逃生舱发布**（对应 PRD 决策 ⑦）。

依据：full-abi 相对 default 的 wasm gzip 增量 **~750KB（855KB vs 105KB，约 8 倍）**，远超 ~100KB 初始阈值——精选模式函数级 GC 裁剪（链接期归档语义 + 未引用代码消除）效果显著，全量 C ABI 导出的体积代价对绝大多数消费者不可接受。105KB gzip 的精选产物落在"可接受的首屏负载"区间（~100KB 为量级锚非硬顶；消费者真实首屏 ≈ wasm gzip 105.4KB + js glue gzip ~13KB ≈ 118KB——js gzip 未入 M1 报告，M2 补计费口径，评审 perf F3/F4）。

注意（评审门议题）：上述 8 倍增量是 -O2 vs -O3 的混合对照；但即便 full-abi 也回到 -O3，全量导出（2745 函数 + 全量解码器）相对精选裁剪的量级差距不会逆转——裁决方向稳健，精确数字待 M2 同优化级别复核。评审 perf 视角量化（2026-09-04）：gzip(full-abi) ≥ ~2× gzip(default) 是结构性下界（full-abi 严格包含 default 全功能 + 全解码侧 + ~2700 函数体传递闭包）；且 -O2 关 metadce 使 full-abi 偏大，实测 8x 是保守上界而非下界。同优化级别复核无需解导出名压缩——加一次 default@-O2 对照构建（复用依赖仅 ~6s 链接）即得干净对照。

## 后续动作

- [x] 手动触发 `size-spike` workflow（7 次 CI 迭代后全绿，演进记录见 journal），回填结果表与结论。
- M1 评审门：trellis-check + chatroom 评审 + 用户确认后进入 M2。
- M2：`check-exports.mjs`（防止绑定回归 + 库级解码符号缺席断言自动化：png_create_read_struct / png_read_* / jpeg_read_header / jpeg_start_decompress / inflateInit_* 系 = 0，正则 \w* 收紧——评审 perf F2/F5）+ CI 体积门禁（**预算阶梯制**而非静态锚定 105KB：M2 设初始预算含余量说明，M4 算子集冻结后重定基线——评审 perf F1，DWA 形态学等体积大户将使 default 增长）。
