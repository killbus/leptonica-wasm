import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { inflateSync } from "node:zlib";

function usage() {
  console.error("usage: node smoke.mjs [--full-abi] [distDir]");
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function check(cond, msg) {
  if (!cond) fail(msg);
}

// Decode a minimal grayscale PNG (color type 0, bit depth 8, non-interlaced)
// into raw pixel rows — enough for the toGray golden assertions. All five
// PNG row filters are implemented (libpng picks per-row filters with a
// minimum-SAD heuristic; assuming filter 0 would make this decoder
// libpng-strategy-dependent). PNG structure: 8-byte signature, IHDR
// (13 bytes), then IDAT chunks.
function decodeGrayPNG(png) {
  check(png[25] === 0, `decodeGrayPNG expects color type 0, got ${png[25]}`);
  check(png[24] === 8, `decodeGrayPNG expects bit depth 8, got ${png[24]}`);
  check(png[28] === 0, `decodeGrayPNG expects non-interlaced (Adam7 byte 28): ${png[28]}`);
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const w = dv.getUint32(16, false);
  const h = dv.getUint32(20, false);
  let off = 8;
  const idat = [];
  while (off < png.length) {
    const len = dv.getUint32(off, false);
    const type = String.fromCharCode(png[off + 4], png[off + 5], png[off + 6], png[off + 7]);
    if (type === "IDAT") idat.push(png.subarray(off + 8, off + 8 + len));
    off += 12 + len; // length + type + data + CRC
    if (type === "IEND") break;
  }
  const raw = inflateSync(Buffer.concat(idat));
  // 1 filter byte + w data bytes per row; bpp = 1 (8-bit grayscale).
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
  };
  const rows = [];
  let p = 0;
  let prior = null;
  for (let y = 0; y < h; y++) {
    const filter = raw[p++];
    const filt = raw.subarray(p, p + w);
    p += w;
    const recon = new Uint8Array(w);
    for (let x = 0; x < w; x++) {
      const left = x > 0 ? recon[x - 1] : 0;
      const up = prior ? prior[x] : 0;
      const ul = prior && x > 0 ? prior[x - 1] : 0;
      switch (filter) {
        case 0: recon[x] = filt[x]; break;
        case 1: recon[x] = filt[x] + left; break;
        case 2: recon[x] = filt[x] + up; break;
        case 3: recon[x] = filt[x] + ((left + up) >> 1); break;
        case 4: recon[x] = filt[x] + paeth(left, up, ul); break;
        default: fail(`decodeGrayPNG: unknown filter ${filter} at row ${y}`);
      }
    }
    prior = recon;
    rows.push(recon);
  }
  return { w, h, rows };
}

// Independent re-implementation of the pinned leptonica toGray arithmetic
// (commit 13275a27, pixconv.c pixConvertRGBToGray with default weights —
// pix.h perceptual 0.3f/0.5f/0.2f, NOT BT.601). C semantics of
//   val = (l_int32)(rwt*a + gwt*b + bwt*c + 0.5);
// where rwt/gwt/bwt are l_float32 and a/b/c are ints: each product is
// float32, the additions are float32, and only the final + 0.5 is double
// (0.5 is a double literal; float + double promotes to double), then
// truncation — round-half-up on the non-negative result. Mirrored with
// Math.fround at exactly the C-promotion boundaries.
// Anchor discrimination, measured (f32 / naive-double / BT.601 / no-+0.5):
//   (0,255,0):   128 / 128 / 150 / 127  — catches wrong weights (BT.601)
//                                      and missing rounding
//   (255,0,0):    77 /  77 /  76 /  76  — same, other direction
//   (0,0,255):    51 /  51 /  29 /  51  — strongest wrong-weight signal
//   (200,100,50): 120 / 120 / 124 / 120  — mixed channel; no tie here (the
//                                      naive double and f32 agree — the
//                                      load-bearing anchors are the pure
//                                      channels above)
function grayAnchor(r, g, b) {
  const f32sum =
    Math.fround(Math.fround(Math.fround(0.3 * r) + Math.fround(0.5 * g)) + Math.fround(0.2 * b));
  return Math.trunc(f32sum + 0.5);
}

const args = process.argv.slice(2);
let fullAbi = false;
const positional = [];
for (const arg of args) {
  if (arg === "--full-abi") {
    fullAbi = true;
  } else if (arg.startsWith("--")) {
    usage();
    process.exit(2);
  } else {
    positional.push(arg);
  }
}
if (positional.length > 1) {
  usage();
  process.exit(2);
}
const distDir = resolve(positional[0] ?? "dist");
const jsPath = join(distDir, "leptonica.mjs");
const wasmPath = join(distDir, "leptonica.wasm");
if (!existsSync(jsPath) || !existsSync(wasmPath)) {
  fail(`missing ${jsPath} or ${wasmPath}: run "node scripts/build.mjs" first`);
}

const factory = (await import(pathToFileURL(jsPath).href)).default;
const wasmBinary = readFileSync(wasmPath);
const L = await factory({ wasmBinary });

const W = 64;
const H = 64;
const rgba = new Uint8Array(W * H * 4);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    rgba[i] = x * 4;
    rgba[i + 1] = y * 4;
    rgba[i + 2] = x ^ y;
    rgba[i + 3] = 0xff;
  }
}

const pix = L.fromRGBA(rgba, W, H);
check(pix !== null, "fromRGBA(rgba, W, H) should return a Pix");
const pngView = L.toPNG(pix);
check(pngView !== null, "toPNG(pix) should return a view");
const png = new Uint8Array(pngView);
check(png.length > 8, `PNG length should exceed 8 bytes: ${png.length}`);
check(png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47, "PNG signature mismatch");
const pngData = new DataView(png.buffer, png.byteOffset, png.byteLength);
check(pngData.getUint32(16, false) === W, `PNG width mismatch: ${pngData.getUint32(16, false)}`);
check(pngData.getUint32(20, false) === H, `PNG height mismatch: ${pngData.getUint32(20, false)}`);
check(png[24] === 8, `PNG bit depth mismatch: ${png[24]}`);
check(png[25] === 6, `PNG color type mismatch: ${png[25]}`);

const gray = L.toGray(pix);
check(gray !== null, "toGray(pix) should return a Pix");
const grayView = L.toPNG(gray);
check(grayView !== null, "toPNG(gray) should return a view");
const grayPng = new Uint8Array(grayView);
check(grayPng[24] === 8, `gray PNG bit depth mismatch: ${grayPng[24]}`);
check(grayPng[25] === 0, `gray PNG color type mismatch: ${grayPng[25]}`);

// toGray pixel-value golden sample (M2; the smoke previously asserted only
// the PNG header — bit depth and color type — never the pixel values).
// 2×2 anchors pin the three weights (0.3/0.5/0.2 perceptual, NOT BT.601 —
// verified against the pinned source at 13275a27) and the +0.5 rounding:
// BT.601 would give green 150 / blue 29 vs the real 128 / 51, and a missing
// +0.5 gives green 127 / red 76. See grayAnchor's discrimination table.
// Expected values are computed by the independent grayAnchor()
// re-implementation of the pinned C arithmetic.
{
  const W2 = 2;
  const H2 = 2;
  const anchors = [
    [200, 100, 50], // mixed channel
    [0, 255, 0],    // pure green — 128
    [255, 0, 0],    // pure red — 77
    [0, 0, 255],    // pure blue — 51
  ];
  const rgba2 = new Uint8Array(W2 * H2 * 4);
  anchors.forEach(([r, g, b], i) => {
    rgba2[i * 4] = r;
    rgba2[i * 4 + 1] = g;
    rgba2[i * 4 + 2] = b;
    rgba2[i * 4 + 3] = 0xff;
  });
  const pix2 = L.fromRGBA(rgba2, W2, H2);
  check(pix2 !== null, "fromRGBA(anchor image) should return a Pix");
  const g2 = L.toGray(pix2);
  check(g2 !== null, "toGray(anchor image) should return a Pix");
  const g2png = new Uint8Array(L.toPNG(g2));
  const dec = decodeGrayPNG(g2png);
  check(dec.w === W2 && dec.h === H2, `anchor gray dimensions: ${dec.w}x${dec.h}`);
  for (let y = 0; y < H2; y++) {
    for (let x = 0; x < W2; x++) {
      const got = dec.rows[y][x];
      const [r, g, b] = anchors[y * W2 + x];
      // Hard-coded expected values (M2 review F4): the anchors above are
      // exactly the discrimination table's four rows, in order — computing
      // them at runtime via grayAnchor() would make this a second
      // implementation agreeing with itself, not an independent
      // observation. Values verified once against the pinned source
      // arithmetic (see grayAnchor's table + the notes above).
      const expected = [120, 128, 77, 51][y * W2 + x];
      const want = expected;
      check(got === want, `toGray pixel (${x},${y}) rgb(${r},${g},${b}): got ${got}, want ${want} (weights 0.3/0.5/0.2, f32 round-half-up)`);
    }
  }
}

const jpegView = L.toJPEG(pix, 85);
check(jpegView !== null, "toJPEG(pix, 85) should return a view");
const jpeg = new Uint8Array(jpegView);
check(jpeg[0] === 0xff && jpeg[1] === 0xd8, "JPEG SOI marker mismatch");
check(L.toJPEG(pix, -1) === null, "toJPEG(pix, -1) should return null");
check(L.toJPEG(pix, 101) === null, "toJPEG(pix, 101) should return null");

const outView = L.toRGBA(pix);
check(outView !== null, "toRGBA(pix) should return a view");
const out = new Uint8Array(outView);
check(out.length === W * H * 4, `toRGBA length mismatch: ${out.length}`);
for (let i = 0; i < W * H * 4; i++) {
  if (out[i] !== rgba[i]) {
    fail(`toRGBA byte mismatch at ${i}: ${out[i]} != ${rgba[i]}`);
  }
}

check(L.toRGBA(gray) === null, "toRGBA(gray) should return null");
check(L.fromRGBA(rgba, 0, 64) === null, "fromRGBA(rgba, 0, 64) should return null");
check(L.fromRGBA(new Uint8Array(7), 1, 1) === null, "fromRGBA(short data) should return null");

const exportsSet = new Set(WebAssembly.Module.exports(new WebAssembly.Module(wasmBinary)).map((e) => e.name));
if (fullAbi) {
  check(exportsSet.has("pixReadMemPng"), "full-abi wasm should export pixReadMemPng");
  check(exportsSet.has("pixReadMemJpeg"), "full-abi wasm should export pixReadMemJpeg");
  check(exportsSet.has("malloc"), "full-abi wasm should export malloc");
  check(exportsSet.has("free"), "full-abi wasm should export free");
  // leptonica's CMake globs ALL .c files, so with WebP disabled the archive
  // still contains webpiostub.c's pixReadMemWebP — an error stub returning
  // NULL ("function not present"), not a decoder. The meaningful absence
  // check is therefore on the real WebP decoder symbols, not the stub.
  for (const name of exportsSet) {
    if (/^WebP/.test(name)) {
      fail(`full-abi wasm exports real WebP symbol: ${name}`);
    }
  }
} else {
  // Runtime-surface check for the default (embind-wrapped) mode: the five
  // promised functions must exist as methods on the instantiated module.
  // The symbol-map decode-absence and d.ts drift checks live in
  // check-exports.mjs (which this smoke test complements, not duplicates):
  // here we verify the EmbindModule surface actually callable, which a
  // static symbol-map scan cannot see.
  const dtsPath = join(distDir, "leptonica.d.ts");
  check(existsSync(dtsPath), `missing ${dtsPath}`);
  const dts = readFileSync(dtsPath, "utf8");
  const embindBody = /interface EmbindModule \{([\s\S]*?)\n\}/.exec(dts);
  check(embindBody !== null, "leptonica.d.ts has no EmbindModule interface");
  for (const line of embindBody[1].split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\(/.exec(line);
    if (match && !["Pix"].includes(match[1])) {
      check(typeof L[match[1]] === "function", `embind module should expose ${match[1]}()`);
    }
  }
}

console.log(`smoke OK (${fullAbi ? "full-abi" : "default"} mode)`);
