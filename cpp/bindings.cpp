#include <emscripten/bind.h>
#include <emscripten/val.h>
#include <string>
#include "allheaders.h"
// class_<PIX> needs the complete Pix type for typeid and its (unused) raw
// destructor; the definition lives in leptonica's internal header, which is
// designed to be included after allheaders.h (same combination as bmf.c).
#include "pix_internal.h"

using emscripten::val;
using emscripten::typed_memory_view;

/* ------------------------------------------------------------------ */
/* Chain operators (M4, design §4.2). Call shapes mirror cpp/oracle.c
 * 1:1 — the golden comparison is only meaningful if both sides make the
 * same leptonica calls with the same argument conventions. Any divergence
 * here must be mirrored in oracle.c or the golden suite will catch it. */
/* ------------------------------------------------------------------ */

PIX *fromRGBA(val data, int w, int h) {
  if (w <= 0 || h <= 0 || w > 0x00ffffff / h) return nullptr;
  if (data["length"].as<size_t>() != (size_t)w * (size_t)h * 4) return nullptr;
  PIX *pix = pixCreateNoInit(w, h, 32);
  if (!pix) return nullptr;
  pixSetSpp(pix, 4);
  if (pixGetDepth(pix) != 32 || pixGetWpl(pix) != w || pixGetColormap(pix)) {
    pixDestroy(&pix);
    return nullptr;
  }
  const size_t bytes = (size_t)pixGetWpl(pix) * h * 4;
  val(typed_memory_view<unsigned char>(bytes, reinterpret_cast<unsigned char *>(pixGetData(pix)))).call<void>("set", data);
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
  if (pixSauvolaBinarize(pix, whsize, factor, 1, nullptr, nullptr, nullptr, &pixd) != 0) return nullptr;
  return pixd;
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
  return val(typed_memory_view<unsigned char>(size, data));
}

val toJPEG(PIX *pix, int quality) {
  l_uint8 *data = nullptr;
  size_t size = 0;
  if (!pix || quality < 0 || quality > 100 || pixWriteMemJpeg(&data, &size, pix, quality, 0) != 0 || !data || size == 0) {
    if (data) lept_free(data);
    return val::null();
  }
  return val(typed_memory_view<unsigned char>(size, data));
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
  return val(typed_memory_view<unsigned char>(n * 4, out));
}

EMSCRIPTEN_BINDINGS(leptonica_wasm) {
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
}
