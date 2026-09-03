import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

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
  const symbolsPath = join(distDir, "leptonica.mjs.symbols");
  check(existsSync(symbolsPath), `missing ${symbolsPath}`);
  const symbols = readFileSync(symbolsPath, "utf8");
  // -O3 inlines single-call-site wrappers like pixWriteMemPng into the embind
  // wrapper, so its name legitimately disappears from the symbol map. Encoder
  // presence is already proven byte-level (PNG IHDR / JPEG SOI checks above);
  // the load-bearing assertion is that no decode path survived linking.
  check(!/\bpixRead\w/.test(symbols), "symbol map should not contain pixRead*");
  for (const name of exportsSet) {
    if (/^pix(Read|Write)/.test(name)) {
      fail(`default wasm exports pixRead/pixWrite function: ${name}`);
    }
  }
}

console.log(`smoke OK (${fullAbi ? "full-abi" : "default"} mode)`);
