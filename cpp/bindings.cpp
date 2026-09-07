#include <emscripten.h>
#include <emscripten/bind.h>
#include <emscripten/val.h>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <stdexcept>
#include <string>
#include <utility>
#include "allheaders.h"
// class_<PIX> needs the complete Pix type for typeid and its (unused) raw
// destructor; the definition lives in leptonica's internal header, which is
// designed to be included after allheaders.h (same combination as bmf.c).
#include "pix_internal.h"

using emscripten::val;

#ifdef LEPTONICA_WASM_TEST_INSTRUMENTATION
/* Test-only allocator instrumentation. Leptonica is compiled with
 * LEPTONICA_INTERCEPT_ALLOC in the isolated instrumented build, so every
 * LEPT_* allocation (including PIX structs and raster data) passes through
 * these definitions. The production build does not compile or export any of
 * this surface. */
struct alignas(std::max_align_t) TestAllocationHeader {
  size_t size;
};

static size_t testLiveBlocks = 0;
static size_t testLiveBytes = 0;
static size_t testAllocationAttempts = 0;
static int64_t testFailAfter = -1;
static std::string testNamedFault;

static bool shouldFailTestAllocation() {
  ++testAllocationAttempts;
  if (testFailAfter < 0) return false;
  if (testFailAfter == 0) {
    testFailAfter = -1;  // one-shot: a sweep can continue after the failure
    return true;
  }
  --testFailAfter;
  return false;
}

static void *allocateTestBlock(size_t size, bool zero) {
  if (shouldFailTestAllocation() ||
      size > std::numeric_limits<size_t>::max() - sizeof(TestAllocationHeader)) return nullptr;
  const size_t total = sizeof(TestAllocationHeader) + size;
  auto *header = static_cast<TestAllocationHeader *>(std::malloc(total));
  if (!header) return nullptr;
  header->size = size;
  void *data = header + 1;
  if (zero && size > 0) std::memset(data, 0, size);
  ++testLiveBlocks;
  testLiveBytes += size;
  return data;
}

extern "C" void *leptonica_malloc(size_t size) {
  return allocateTestBlock(size, false);
}

extern "C" void *leptonica_calloc(size_t count, size_t size) {
  if (count != 0 && size > std::numeric_limits<size_t>::max() / count) return nullptr;
  return allocateTestBlock(count * size, true);
}

extern "C" void leptonica_free(void *ptr) {
  if (!ptr) return;
  auto *header = static_cast<TestAllocationHeader *>(ptr) - 1;
  --testLiveBlocks;
  testLiveBytes -= header->size;
  std::free(header);
}

extern "C" void *leptonica_realloc(void *ptr, size_t size) {
  if (!ptr) return leptonica_malloc(size);
  if (size == 0) {
    leptonica_free(ptr);
    return nullptr;
  }
  if (shouldFailTestAllocation() ||
      size > std::numeric_limits<size_t>::max() - sizeof(TestAllocationHeader)) return nullptr;
  auto *oldHeader = static_cast<TestAllocationHeader *>(ptr) - 1;
  const size_t oldSize = oldHeader->size;
  auto *newHeader = static_cast<TestAllocationHeader *>(
    std::realloc(oldHeader, sizeof(TestAllocationHeader) + size));
  if (!newHeader) return nullptr;
  newHeader->size = size;
  testLiveBytes = testLiveBytes - oldSize + size;
  return newHeader + 1;
}

static bool consumeTestFault(const char *name) {
  if (testNamedFault != name) return false;
  testNamedFault.clear();
  return true;
}

static val testAllocationStatsValue() {
  val out = val::object();
  out.set("liveBlocks", static_cast<double>(testLiveBlocks));
  out.set("liveBytes", static_cast<double>(testLiveBytes));
  out.set("allocationAttempts", static_cast<double>(testAllocationAttempts));
  return out;
}

static void testArmAllocationFailure(int successfulAllocationsBeforeFailure) {
  if (successfulAllocationsBeforeFailure < 0) {
    throw std::invalid_argument("allocation failure index must be >= 0");
  }
  testFailAfter = successfulAllocationsBeforeFailure;
}

static void testArmFault(std::string name) {
  if (name != "copyJsBytesToWasm" && name != "copyWasmBytesToJs" &&
      name != "sauvola.partial" && name != "sauvolaTiled.partial" &&
      name != "fatalTrap") {
    throw std::invalid_argument("unknown test fault");
  }
  testNamedFault = std::move(name);
}

static void testClearFaults() {
  testFailAfter = -1;
  testNamedFault.clear();
}
#else
static bool consumeTestFault(const char *) { return false; }
#endif

#ifdef PRODUCT_LOCK
#include "generated_domain.inc"

EM_JS(int, leptonica_authorized_host, (const char *domain_ptr, const char *dot_domain_ptr), {
  const root = typeof globalThis === "object" && globalThis ? globalThis : {};
  const processObject = root.process;
  const trustedNode = !!(
    processObject &&
    processObject.release &&
    processObject.release.name === "node" &&
    processObject.versions &&
    typeof processObject.versions.node === "string"
  );
  if (trustedNode) return 1;

  const locationObject = root.location;
  const hostname = locationObject && typeof locationObject.hostname === "string"
    ? locationObject.hostname.toLowerCase().replace(/\.$/, "")
    : "";
  if (!hostname) return 0;

  const domain = UTF8ToString(domain_ptr);
  const dotDomain = UTF8ToString(dot_domain_ptr);
  return hostname === domain || hostname.endsWith(dotDomain) ? 1 : 0;
});

static void xorDecode(unsigned char *data) {
  for (size_t i = 0; data[i] != 0; i++) data[i] ^= 0x5A;
}

static void enforceAuthorizedHost() {
  xorDecode(x_domain);
  xorDecode(x_dot_domain);
  if (!leptonica_authorized_host(
        reinterpret_cast<const char *>(x_domain),
        reinterpret_cast<const char *>(x_dot_domain))) {
    __builtin_trap();
  }
}
#else
static void enforceAuthorizedHost() {}
#endif

/* JS exceptions must not cross a C++ frame while that frame owns native
 * storage. These helpers contain allocation/view failures and return a
 * status or a null handle, allowing C++ to release PIX/buffer ownership on
 * every path. */
EM_JS(int, copyJsBytesToWasm, (emscripten::EM_VAL source_handle, uint8_t *dest, size_t size, int force_fail), {
  try {
    if (force_fail) return 0;
    const source = Emval.toValue(source_handle);
    if (!ArrayBuffer.isView(source) || source.byteLength !== size) return 0;
    const bytes = new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
    HEAPU8.set(bytes, dest);
    return 1;
  } catch (_) {
    return 0;
  }
});

EM_JS(emscripten::EM_VAL, copyWasmBytesToJs, (const uint8_t *source, size_t size, int force_fail), {
  try {
    if (force_fail) return Emval.toHandle(null);
    const out = new Uint8Array(size);
    out.set(HEAPU8.subarray(source, source + size));
    return Emval.toHandle(out);
  } catch (_) {
    return Emval.toHandle(null);
  }
});

/* Copy a C heap buffer into a freshly allocated JS Uint8Array, then free
 * the native allocation regardless of whether JS allocation/copy succeeds. */
static val copyToJs(uint8_t *data, size_t size) {
  emscripten::EM_VAL handle = copyWasmBytesToJs(
    data, size, consumeTestFault("copyWasmBytesToJs") ? 1 : 0);
  lept_free(data);
  return val::take_ownership(handle);
}

/* ------------------------------------------------------------------ */
/* Chain operators (M4, design §4.2). Call shapes mirror cpp/oracle.c
 * 1:1 — the golden comparison is only meaningful if both sides make the
 * same leptonica calls with the same argument conventions. Any divergence
 * here must be mirrored in oracle.c or the golden suite will catch it. */
/* ------------------------------------------------------------------ */

PIX *fromRGBA(val data, int w, int h) {
  if (consumeTestFault("fatalTrap")) __builtin_trap();
  if (w <= 0 || h <= 0 || w > 0x00ffffff / h) return nullptr;
  const size_t bytes = (size_t)w * (size_t)h * 4;
  PIX *pix = pixCreateNoInit(w, h, 32);
  if (!pix) return nullptr;
  pixSetSpp(pix, 4);
  if (pixGetDepth(pix) != 32 || pixGetWpl(pix) != w || pixGetColormap(pix)) {
    pixDestroy(&pix);
    return nullptr;
  }
  if (!copyJsBytesToWasm(
        data.as_handle(),
        reinterpret_cast<unsigned char *>(pixGetData(pix)),
        bytes,
        consumeTestFault("copyJsBytesToWasm") ? 1 : 0)) {
    pixDestroy(&pix);
    return nullptr;
  }
  if (pixEndianByteSwap(pix) != 0) {
    pixDestroy(&pix);
    return nullptr;
  }
  return pix;
}

/* Curated-layer lifetime helpers (M4 core). The chain builder owns Pix
 * handles; these expose the three facts it needs from C:
 *   - destroyPix: pixDestroy(&p) semantics (NULLs the caller's slot).
 *     Embind's class_<PIX> has no destructor registration, so without
 *     this the TS layer would have no way to free a Pix at all.
 *   - pixWidth/pixHeight/pixDepth: read-only geometry for getters and
 *     the chain-build depth cursor. All three are O(1) field reads in
 *     pix1.c; validating before every op would be redundant with the
 *     curated layer's own checks, so they stay plain accessors.
 *     (dimensions live in the PIX struct; there is no "invalid" Pix to
 *     detect here — null is the only failure mode.) */
void destroyPix(PIX *pix) {
  pixDestroy(&pix);
}

int pixWidth(PIX *pix) {
  return pix ? pixGetWidth(pix) : -1;
}

int pixHeight(PIX *pix) {
  return pix ? pixGetHeight(pix) : -1;
}

int pixDepth(PIX *pix) {
  return pix ? pixGetDepth(pix) : -1;
}

PIX *toGray(PIX *pix) {
  if (!pix) return nullptr;
  return pixConvertTo8(pix, 0);
}

PIX *toGrayWeighted(PIX *pix, float r, float g, float b) {
  if (!pix) return nullptr;
  return pixConvertRGBToGray(pix, r, g, b);
}

PIX *threshold(PIX *pix, int level) {
  if (!pix) return nullptr;
  return pixThresholdToBinary(pix, level);
}

/* Otsu adaptive threshold, mirrored from pixOtsuAdaptiveThreshold
 * (binarize.c:157) — but with pixSplitDistributionFgBg inlined to its
 * exact non-debug expansion (pix4.c:3449-3460, the else branch otsu's
 * ppixdb=NULL call takes). Reason: the wrapper's *body* also contains
 * the debug branch, which calls gplotMakeOutputPix → pixRead → the whole
 * decode cluster; a call site that passes NULL is indistinguishable to
 * the linker, so the decode path cannot be gc'd when we call the wrapper.
 * Mirroring the loop keeps the exact same leptonica calls on both sides
 * (oracle.c opOtsu) while dropping the decode-side reference. */
PIX *otsu(PIX *pix, int tile, float factor) {
  if (!pix || pixGetDepth(pix) != 8 || tile < 16) return nullptr;
  l_int32 w, h, nx, ny, i, j, thresh;
  pixGetDimensions(pix, &w, &h, nullptr);
  nx = L_MAX(1, w / tile);
  ny = L_MAX(1, h / tile);
  PIX *pixd = pixCreate(w, h, 1);
  if (!pixd) return nullptr;
  pixCopyResolution(pixd, pix);
  PIXTILING *pt = pixTilingCreate(pix, nx, ny, 0, 0, 0, 0);
  if (!pt) { pixDestroy(&pixd); return nullptr; }
  for (i = 0; i < ny; i++) {
    for (j = 0; j < nx; j++) {
      PIX *pixt = pixTilingGetTile(pt, i, j);
      if (!pixt) continue;
      /* pixSplitDistributionFgBg(pixt, factor, 1, &thresh, ...) expanded:
       * the debug branch is the decode-path leak; this is the else. */
      PIX *pixg = pixConvertTo8BySampling(pixt, 1, 0);
      NUMA *na = pixGetGrayHistogram(pixg, 1);
  numaSplitDistribution(na, factor, &thresh, nullptr, nullptr, nullptr, nullptr, nullptr);
      numaDestroy(&na);
      pixDestroy(&pixg);
      PIX *pixb = pixThresholdToBinary(pixt, thresh);
      pixTilingPaintTile(pixd, i, j, pixb, pt);
      pixDestroy(&pixt);
      pixDestroy(&pixb);
    }
  }
  pixTilingDestroy(&pt);
  return pixd;
}

PIX *sauvola(PIX *pix, int whsize, float factor) {
  if (!pix) return nullptr;
  PIX *pixd = nullptr;
  int result = pixSauvolaBinarize(pix, whsize, factor, 1, nullptr, nullptr, nullptr, &pixd);
  if (result == 0 && consumeTestFault("sauvola.partial")) result = 1;
  if (result != 0) {
    pixDestroy(&pixd);
    return nullptr;
  }
  return pixd;
}

PIX *cleanBackgroundToWhite(PIX *pix, float gamma, int blackval, int whiteval) {
  if (!pix || pixGetColormap(pix)) return nullptr;
  const int depth = pixGetDepth(pix);
  if ((depth != 8 && depth != 32) || !std::isfinite(gamma) || gamma <= 0.0f ||
      blackval >= whiteval || whiteval > 200) return nullptr;
  return pixCleanBackgroundToWhite(pix, nullptr, nullptr, gamma, blackval, whiteval);
}

PIX *sauvolaTiled(PIX *pix, int whsize, float factor, int nx, int ny) {
  if (!pix || pixGetDepth(pix) != 8 || pixGetColormap(pix) || whsize < 2 ||
      !std::isfinite(factor) || factor < 0.0f || nx < 1 || ny < 1) return nullptr;
  int w = 0, h = 0;
  pixGetDimensions(pix, &w, &h, nullptr);
  const int minDimension = L_MIN(w, h);
  if (minDimension < 7 || whsize > (minDimension - 3) / 2) return nullptr;
  const int minTileDimension = whsize + 2;  // safe: whsize <= (minDimension - 3) / 2
  if (w / nx < minTileDimension || h / ny < minTileDimension) return nullptr;
  PIX *pixd = nullptr;
  int result = pixSauvolaBinarizeTiled(pix, whsize, factor, nx, ny, nullptr, &pixd);
  if (result == 0 && consumeTestFault("sauvolaTiled.partial")) result = 1;
  if (result != 0) {
    pixDestroy(&pixd);
    return nullptr;
  }
  return pixd;
}

PIX *selectByArea(PIX *pix, float thresholdArea, int connectivity, val relation) {
  if (!pix || pixGetDepth(pix) != 1 || !std::isfinite(thresholdArea) || thresholdArea < 0 ||
      (connectivity != 4 && connectivity != 8)) return nullptr;
  const std::string rel = relation.as<std::string>();
  int type = 0;
  if (rel == "lt") type = L_SELECT_IF_LT;
  else if (rel == "gt") type = L_SELECT_IF_GT;
  else if (rel == "lte") type = L_SELECT_IF_LTE;
  else if (rel == "gte") type = L_SELECT_IF_GTE;
  else return nullptr;
  l_int32 changed = 0;
  return pixSelectByArea(pix, thresholdArea, connectivity, type, &changed);
}

PIX *maskOverColorPixels(PIX *pix, int thresholdDiff, int minDistance) {
  if (!pix || pixGetDepth(pix) != 32 || pixGetColormap(pix) ||
      thresholdDiff < 0 || thresholdDiff > 255 || minDistance < 1) return nullptr;
  const int minDimension = L_MIN(pixGetWidth(pix), pixGetHeight(pix));
  const int maxFittingDistance = minDimension / 2 + minDimension % 2;
  if (minDistance > maxFittingDistance) {
    // Leptonica's default asymmetric erosion boundary treats pixels outside
    // the image as OFF. A centered (2 * minDistance - 1) brick larger than
    // either image axis therefore cannot fit at any output pixel. Return the
    // equivalent empty mask without constructing an enormous SEL.
    return pixCreate(pixGetWidth(pix), pixGetHeight(pix), 1);
  }
  return pixMaskOverColorPixels(pix, thresholdDiff, minDistance);
}

PIX *deskew(PIX *pix, int reduction) {
  if (!pix) return nullptr;
  return pixDeskew(pix, reduction);
}

PIX *rotate(PIX *pix, float angle, val quality) {
  if (!pix) return nullptr;
  const bool shear = quality.as<std::string>() == "shear";
  return pixRotate(pix, angle, shear ? L_ROTATE_SHEAR : L_ROTATE_AREA_MAP, L_BRING_IN_WHITE, 0, 0);
}

PIX *scale(PIX *pix, float fx, float fy) {
  if (!pix) return nullptr;
  return pixScale(pix, fx, fy);
}

PIX *shear(PIX *pix, val direction, float angle) {
  if (!pix) return nullptr;
  const bool horizontal = direction.as<std::string>() == "h";
  if (horizontal) return pixHShearCenter(nullptr, pix, angle, L_BRING_IN_WHITE);
  return pixVShearCenter(nullptr, pix, angle, L_BRING_IN_WHITE);
}

PIX *clip(PIX *pix, int x, int y, int w, int h) {
  if (!pix) return nullptr;
  BOX *box = boxCreate(x, y, w, h);
  PIX *out = pixClipRectangle(pix, box, nullptr);
  boxDestroy(&box);
  return out;
}

PIX *translate(PIX *pix, int dx, int dy) {
  if (!pix) return nullptr;
  return pixTranslate(nullptr, pix, dx, dy, L_BRING_IN_WHITE);
}

PIX *morphDilate(PIX *pix, int w, int h) {
  if (!pix) return nullptr;
  return pixDilateBrickDwa(nullptr, pix, w, h);
}

PIX *morphErode(PIX *pix, int w, int h) {
  if (!pix) return nullptr;
  return pixErodeBrickDwa(nullptr, pix, w, h);
}

PIX *morphOpen(PIX *pix, int w, int h) {
  if (!pix) return nullptr;
  return pixOpenBrickDwa(nullptr, pix, w, h);
}

PIX *morphClose(PIX *pix, int w, int h) {
  if (!pix) return nullptr;
  return pixCloseBrickDwa(nullptr, pix, w, h);
}

PIX *bitwiseOr(PIX *pix, PIX *other) {
  if (!pix || !other) return nullptr;
  /* pixOr returns pixd (PIX*), NOT a status code — the previous form
   * compared the returned pointer against 0 and destroyed a valid
   * result on every success. Case (a): pixd=NULL lets pixOr allocate
   * and copy internally. */
  return pixOr(nullptr, pix, other);
}

PIX *bitwiseAnd(PIX *pix, PIX *other) {
  if (!pix || !other) return nullptr;
  return pixAnd(nullptr, pix, other);
}

PIX *bitwiseXor(PIX *pix, PIX *other) {
  if (!pix || !other) return nullptr;
  return pixXor(nullptr, pix, other);
}

PIX *blend(PIX *pix, PIX *other, float frac) {
  if (!pix || !other) return nullptr;
  return pixBlend(pix, other, 0, 0, frac);
}

PIX *addBorder(PIX *pix, int t, int val) {
  if (!pix) return nullptr;
  return pixAddBorder(pix, t, val);
}

PIX *sobel(PIX *pix, val orientation) {
  if (!pix) return nullptr;
  const std::string orient = orientation.as<std::string>();
  int flag = L_ALL_EDGES;
  if (orient == "h") flag = L_HORIZONTAL_EDGES;
  else if (orient == "v") flag = L_VERTICAL_EDGES;
  return pixSobelEdgeFilter(pix, flag);
}

/* Queries (design §4.2 — values, no Pix produced). */

val findSkew(PIX *pix) {
  if (!pix) return val::null();
  l_float32 angle = 0, conf = 0;
  if (pixFindSkew(pix, &angle, &conf) != 0) return val::null();
  val out = val::object();
  out.set("angle", angle);
  out.set("confidence", conf);
  return out;
}

int countPixels(PIX *pix) {
  if (!pix) return -1;
  l_int32 count = 0;
  if (pixCountPixels(pix, &count, 0) != 0) return -1;
  return count;
}

val connComp(PIX *pix) {
  if (!pix || pixGetDepth(pix) != 1) return val::null();
  BOXA *boxa = pixConnComp(pix, nullptr, 8);
  if (!boxa) return val::null();
  const int n = boxaGetCount(boxa);
  val out = val::array();
  for (int i = 0; i < n; i++) {
    BOX *box = boxaGetBox(boxa, i, L_CLONE);
    if (!box) continue;
    l_int32 x = 0, y = 0, w = 0, h = 0;
    boxGetGeometry(box, &x, &y, &w, &h);
    val b = val::object();
    b.set("x", x);
    b.set("y", y);
    b.set("w", w);
    b.set("h", h);
    out.call<void>("push", b);
    boxDestroy(&box);
  }
  boxaDestroy(&boxa);
  return out;
}

val histogram(PIX *pix) {
  if (!pix) return val::null();
  NUMA *na = pixGetGrayHistogram(pix, 1);
  if (!na) return val::null();
  val out = val::array();
  for (int i = 0; i < 256; i++) {
    l_int32 v = 0;
    if (numaGetIValue(na, i, &v) != 0) { numaDestroy(&na); return val::null(); }
    out.call<void>("push", v);
  }
  numaDestroy(&na);
  return out;
}

val average(PIX *pix) {
  if (!pix) return val::null();
  l_float32 avg = 0;
  if (pixGetAverageMasked(pix, nullptr, 0, 0, 1, L_MEAN_ABSVAL, &avg) != 0) return val::null();
  return val(avg);
}

val toPNG(PIX *pix) {
  l_uint8 *data = nullptr;
  size_t size = 0;
  if (!pix || pixWriteMemPng(&data, &size, pix, 0.0f) != 0 || !data || size == 0) {
    if (data) lept_free(data);
    return val::null();
  }
  return copyToJs(data, size);
}

val toJPEG(PIX *pix, int quality) {
  l_uint8 *data = nullptr;
  size_t size = 0;
  if (!pix || quality < 0 || quality > 100 || pixWriteMemJpeg(&data, &size, pix, quality, 0) != 0 || !data || size == 0) {
    if (data) lept_free(data);
    return val::null();
  }
  return copyToJs(data, size);
}

val toRGBA(PIX *pix) {
  if (!pix || pixGetDepth(pix) != 32) return val::null();
  const size_t n = (size_t)pixGetWidth(pix) * (size_t)pixGetHeight(pix);
  unsigned char *out = (unsigned char *)lept_calloc(n * 4, 1);
  if (!out) return val::null();
  const l_uint32 *words = pixGetData(pix);
  for (size_t i = 0; i < n; i++) {
    const l_uint32 pixel = words[i];
    out[i * 4 + 0] = (unsigned char)(pixel >> 24);
    out[i * 4 + 1] = (unsigned char)((pixel >> 16) & 0xff);
    out[i * 4 + 2] = (unsigned char)((pixel >> 8) & 0xff);
    out[i * 4 + 3] = (unsigned char)(pixel & 0xff);
  }
  return copyToJs(out, n * 4);
}

val toMask(PIX *pix) {
  if (!pix || pixGetDepth(pix) != 1) return val::null();
  const int w = pixGetWidth(pix);
  const int h = pixGetHeight(pix);
  if (w <= 0 || h <= 0) return val::null();
  const size_t stride = ((size_t)w + 7u) / 8u;
  if (stride > std::numeric_limits<size_t>::max() / (size_t)h) return val::null();
  const size_t size = stride * (size_t)h;
  auto *out = static_cast<l_uint8 *>(lept_calloc(size, 1));
  if (!out) return val::null();
  l_uint32 *data = pixGetData(pix);
  const int wpl = pixGetWpl(pix);
  for (int y = 0; y < h; ++y) {
    l_uint32 *line = data + (size_t)y * wpl;
    l_uint8 *row = out + (size_t)y * stride;
    for (int x = 0; x < w; ++x) {
      if (GET_DATA_BIT(line, x)) row[x >> 3] |= (l_uint8)(0x80u >> (x & 7));
    }
  }
  return copyToJs(out, size);
}

EMSCRIPTEN_BINDINGS(leptonica_wasm) {
  // Fail before registering any Embind surface for a locked browser build.
  enforceAuthorizedHost();
  emscripten::class_<PIX>("Pix");
  emscripten::function("destroyPix", &destroyPix, emscripten::allow_raw_pointers());
  emscripten::function("pixWidth", &pixWidth, emscripten::allow_raw_pointers());
  emscripten::function("pixHeight", &pixHeight, emscripten::allow_raw_pointers());
  emscripten::function("pixDepth", &pixDepth, emscripten::allow_raw_pointers());
  emscripten::function("fromRGBA", &fromRGBA, emscripten::allow_raw_pointers());
  emscripten::function("toGray", &toGray, emscripten::allow_raw_pointers());
  emscripten::function("toGrayWeighted", &toGrayWeighted, emscripten::allow_raw_pointers());
  emscripten::function("threshold", &threshold, emscripten::allow_raw_pointers());
  emscripten::function("otsu", &otsu, emscripten::allow_raw_pointers());
  emscripten::function("sauvola", &sauvola, emscripten::allow_raw_pointers());
  emscripten::function("cleanBackgroundToWhite", &cleanBackgroundToWhite, emscripten::allow_raw_pointers());
  emscripten::function("sauvolaTiled", &sauvolaTiled, emscripten::allow_raw_pointers());
  emscripten::function("selectByArea", &selectByArea, emscripten::allow_raw_pointers());
  emscripten::function("maskOverColorPixels", &maskOverColorPixels, emscripten::allow_raw_pointers());
  emscripten::function("deskew", &deskew, emscripten::allow_raw_pointers());
  emscripten::function("rotate", &rotate, emscripten::allow_raw_pointers());
  emscripten::function("scale", &scale, emscripten::allow_raw_pointers());
  emscripten::function("shear", &shear, emscripten::allow_raw_pointers());
  emscripten::function("clip", &clip, emscripten::allow_raw_pointers());
  emscripten::function("translate", &translate, emscripten::allow_raw_pointers());
  emscripten::function("morphDilate", &morphDilate, emscripten::allow_raw_pointers());
  emscripten::function("morphErode", &morphErode, emscripten::allow_raw_pointers());
  emscripten::function("morphOpen", &morphOpen, emscripten::allow_raw_pointers());
  emscripten::function("morphClose", &morphClose, emscripten::allow_raw_pointers());
  emscripten::function("bitwiseOr", &bitwiseOr, emscripten::allow_raw_pointers());
  emscripten::function("bitwiseAnd", &bitwiseAnd, emscripten::allow_raw_pointers());
  emscripten::function("bitwiseXor", &bitwiseXor, emscripten::allow_raw_pointers());
  emscripten::function("blend", &blend, emscripten::allow_raw_pointers());
  emscripten::function("addBorder", &addBorder, emscripten::allow_raw_pointers());
  emscripten::function("sobel", &sobel, emscripten::allow_raw_pointers());
  emscripten::function("findSkew", &findSkew, emscripten::allow_raw_pointers());
  emscripten::function("countPixels", &countPixels, emscripten::allow_raw_pointers());
  emscripten::function("connComp", &connComp, emscripten::allow_raw_pointers());
  emscripten::function("histogram", &histogram, emscripten::allow_raw_pointers());
  emscripten::function("average", &average, emscripten::allow_raw_pointers());
  emscripten::function("toPNG", &toPNG, emscripten::allow_raw_pointers());
  emscripten::function("toJPEG", &toJPEG, emscripten::allow_raw_pointers());
  emscripten::function("toRGBA", &toRGBA, emscripten::allow_raw_pointers());
  emscripten::function("toMask", &toMask, emscripten::allow_raw_pointers());
#ifdef LEPTONICA_WASM_TEST_INSTRUMENTATION
  emscripten::function("testAllocationStats", &testAllocationStatsValue);
  emscripten::function("testArmAllocationFailure", &testArmAllocationFailure);
  emscripten::function("testArmFault", &testArmFault);
  emscripten::function("testClearFaults", &testClearFaults);
#endif
}
