#include <emscripten/bind.h>
#include <emscripten/val.h>
#include "allheaders.h"
// class_<PIX> needs the complete Pix type for typeid and its (unused) raw
// destructor; the definition lives in leptonica's internal header, which is
// designed to be included after allheaders.h (same combination as bmf.c).
#include "pix_internal.h"

using emscripten::val;
using emscripten::typed_memory_view;

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

PIX *toGray(PIX *pix) {
  if (!pix) return nullptr;
  return pixConvertTo8(pix, 0);
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
  emscripten::function("fromRGBA", &fromRGBA, emscripten::allow_raw_pointers());
  emscripten::function("toGray", &toGray, emscripten::allow_raw_pointers());
  emscripten::function("toPNG", &toPNG, emscripten::allow_raw_pointers());
  emscripten::function("toJPEG", &toJPEG, emscripten::allow_raw_pointers());
  emscripten::function("toRGBA", &toRGBA, emscripten::allow_raw_pointers());
}
