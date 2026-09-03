# size spike 研究（M1）

> 命名偏差：design.md §8 与 implement.md 指定产物名为 `research/size-spike.md`；实际落盘为本任务目录下的扁平文件 `research-size-spike.md`，与既有 `research-vendor-pins.md` / `research-tesseract-wasm.md` / `research-liteparse.md` 的扁平命名约定一致。

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

- 公共：`emcmake cmake -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=<install> -DCMAKE_PREFIX_PATH=<install> -DCMAKE_POLICY_VERSION_MINIMUM=3.5`。`CMAKE_POLICY_VERSION_MINIMUM=3.5` 是 CMake 4.2 跑通旧策略声明（`cmake_minimum_required` < 3.5）依赖的关键。
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
- M1 有意简化：编码器输出缓冲不释放（泄漏换正确性），失败路径 `lept_free` 兜底。

### 链接

- 公共 flags：`--no-entry -lembind --emit-symbol-map --emit-tsd=<out>/leptonica.d.ts -sMODULARIZE=1 -sEXPORT_ES6=1 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=33554432 -sENVIRONMENT=web,worker,node`；优化级别按模式分（见下）。`-sWASM_BIGINT=1` 初版曾带，emsdk 6.0.9 已废弃（CI 警告 "no longer needed"），已移除。
- default 模式：**`-O3`** + 普通 `-lleptonica -lpng16 -ljpeg -lz`（归档语义），链接器函数级 GC 裁掉未引用代码 → 解码路径不进产物。
- full-abi 模式：**`-O2`**（非 -O3）+ `-Wl,--whole-archive -lleptonica -Wl,--no-whole-archive` + `-sEXPORTED_FUNCTIONS=@<abs>`；导出表缺失符号即链接硬报错。-O2 原因（2026-09-03 CI run 33750787506/33754958056 迭代发现）：-O3 下 metadce 链启用 wasm 导出名压缩（`da, ea, …`），而 `MINIFY_WASM_EXPORT_NAMES` 是内部设置不可从 CLI 关闭；raw C ABI 需要真名，唯一干净 CLI 杠杆是把优化级别降到 -O2 关掉 metadce。代价：full-abi 体积测量混入优化级别变量（-O2 vs default 的 -O3）——对照解读时须注意，M2 可用 post-link 重命名（symbol map 可逆映射）回到 -O3 后 revisit。
- 导出表生成：allheaders.h 提取（`LEPT_DLL extern` 声明）∩ `emnm --defined-only`（libleptonica.a 实际定义）+ `_malloc` / `_free`，排序落 `tmp/build/full-abi-exports.txt`。交集过滤排除未编译的编解码器（如 `pixReadMemWebP`，WebP 已禁用）。
- 不加 `-lm`（wasm 目标下 emscripten 自带 math 实现，链接系统库无意义）；M1 不加 `-sFILESYSTEM=0`（留 M2 裁剪）。

### 验证

- 产物旁 `.symbols` 符号表（`--emit-symbol-map`）做 name-section 级检查：default 模式不含任何 `pixRead\*`；同时检查 `WebAssembly.Module.exports` 无 `pixRead` / `pixWrite` 导出。（初版还断言 `pixWriteMemPng` 名字在场——实测 -O3 将单一调用点的 wrapper 内联进 embind 包装后该名从 name section 消失，属合法优化；编码器在场已由字节级断言证明，断言已收窄。2026-09-03，CI run 33744418718。）
- 冒烟：64×64 渐变图 → PNG IHDR 逐项断言（签名 / 宽高 / 位深 8 / 颜色类型 6）、灰度 PNG（位深 8 / 颜色类型 0）、JPEG SOI（`ff d8`）、toRGBA 字节级往返、负向用例（非法 quality、非法宽高、短缓冲、灰度图 toRGBA 返回 null）。
- full-abi 冒烟：`pixReadMemPng` / `pixReadMemJpeg` / `malloc` / `free` 在 wasm 导出表中、无真实 `WebP*` 解码符号。（初版断言 `pixReadMemWebP` 缺席——实测该符号**在场**：leptonica `src/CMakeLists.txt` 用 `file(GLOB src "*.c")` 全量编译，WebP 关闭时 `webpiostub.c` 提供同名错误桩（返回 NULL "function not present"），`webpio.c` 实现整体被 `HAVE_LIBWEBP` 守卫掉；故 gen-exports 的"声明∩定义"交集正确含入该桩。真实判据是解码器符号缺席（`WebP*` 计 0），非桩名缺席。2026-09-03，CI run 33754958056。）
- 确定性：CI 中双次从零构建（第二次 `rm -rf dist tmp/build`）比对 `wasmSha256` 一致。

## 结果

| mode | wasm bytes | wasm gzip bytes | js bytes | wall (s) |
| --- | ---: | ---: | ---: | ---: |
| default | TBD | TBD | TBD | TBD |
| full-abi | TBD | TBD | TBD | TBD |

（待 `size-spike` workflow 运行后回填。）

## 结论

TBD。裁决规则：若 full-abi 相对 default 的 wasm gzip 增量 < ~100KB，则默认产物直接全量导出；否则精选 5 函数为默认、full-abi 作为逃生舱发布。（阈值 ~100KB 为初始提案，待用户确认。）

## 后续动作

- 手动触发 `size-spike` workflow（workflow_dispatch），回填结果表与结论。
- M1 评审门：trellis-check + chatroom 评审 + 用户确认后进入 M2。
- M2：`check-exports.mjs`（防止绑定回归）+ CI 体积门禁（gzip 上限）。
