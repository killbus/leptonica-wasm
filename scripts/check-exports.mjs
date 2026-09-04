// CI guard against binding drift and decode-path regressions (M2).
//
// Two layers, per review perf F2/F5 and trellis-check nit-1:
//   1. Symbol-level decode absence (default mode): the load-bearing proof
//      that function-level GC kept the write-only shape. The old smoke
//      assertions were one-weak (regex /\bpixRead\w/ misses the bare name
//      `pixRead`) and one-inert (-O3 metadce minifies wasm export names to
//      da/ea/..., so /^pix(Read|Write)/ over WebAssembly.Module.exports can
//      never fire in default mode). The strong evidence — library-level
//      DECODER symbols absent from the symbol map — was a one-off manual
//      verification; this script makes it a standing CI check.
//   2. d.ts ↔ wasm export diff (full-abi mode): every symbol the d.ts
//      WasmModule interface declares must exist in WebAssembly.Module.exports.
//      For full-abi, export names are real C names (-O2, metadce off).
//      Default-mode d.ts has an empty WasmModule (embind wraps everything),
//      so its comparison object is the EmbindModule interface — checked in
//      the smoke script instead, which instantiates the module.
//
// Usage: node check-exports.mjs [--full-abi] <distDir>

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

function usage() {
  console.error("usage: node check-exports.mjs [--full-abi] <distDir>");
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
if (positional.length !== 1) {
  usage();
  process.exit(2);
}
const distDir = resolve(positional[0]);

// ── Layer 1 (default mode only): decode symbols absent from symbol map ──
//
// The full-abi build IS the escape hatch that exports the whole C ABI —
// decode paths included by design. Decode absence is the invariant of the
// default (curated) artifact only.
//
// A leptonica decode wrapper cannot exist without the library decoder it
// calls, so absence of the decoder is the deeper invariant. PNG read goes
// through png_create_read_struct/png_read_*; JPEG read through
// jpeg_read_header/jpeg_start_decompress; anything inflate'd through
// zlib's inflateInit*. gzip DEFLATE on the encode side (deflateInit*) is
// expected to be present and is NOT checked here.
const DECODE_SYMBOL_PATTERNS = [
  /^pixRead\w*$/,
  /^png_create_read_struct$/,
  /^png_read_\w+$/,
  /^png_set_read_fn$/,
  /^png_set_read$/,
  /^jpeg_read_header$/,
  /^jpeg_start_decompress$/,
  /^jpeg_finish_decompress$/,
  /^jpeg_read_scanlines$/,
  /^inflateInit2?_?$/,
  /^inflate$/,
  /^inflateEnd$/,
  /^zlibVersion$/,
];

function readSymbolMap(distDir) {
  const symbolsPath = join(distDir, "leptonica.mjs.symbols");
  if (!existsSync(symbolsPath)) {
    return null;
  }
  // Format: "<id>:<name>" per line (emcc --emit-symbol-map).
  return readFileSync(symbolsPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\d+:/, ""))
    .filter((name) => name.length > 0);
}

let symbolCount = null;
if (!fullAbi) {
  const symbols = readSymbolMap(distDir);
  if (symbols === null) {
    fail(`missing ${join(distDir, "leptonica.mjs.symbols")}: run the build first`);
  }
  symbolCount = symbols.length;
  const symbolSet = new Set(symbols);
  for (const pattern of DECODE_SYMBOL_PATTERNS) {
    for (const name of symbolSet) {
      if (pattern.test(name)) {
        fail(`symbol map contains decode-path symbol: ${name} (pattern ${pattern})`);
      }
    }
  }
}

// ── Layer 2 (full-abi): d.ts WasmModule symbols ⊆ wasm exports ──
if (fullAbi) {
  const dtsPath = join(distDir, "leptonica.d.ts");
  check(existsSync(dtsPath), `missing ${dtsPath}`);
  const dts = readFileSync(dtsPath, "utf8");
  // WasmModule interface body: from "interface WasmModule {" to the closing
  // "}" — extract the declared function names (leading "_", C ABI shape).
  const wasmModuleBody = /interface WasmModule \{([\s\S]*?)\n\}/.exec(dts);
  check(wasmModuleBody !== null, "leptonica.d.ts has no WasmModule interface");
  const declared = new Set();
  for (const line of wasmModuleBody[1].split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\(/.exec(line);
    if (match) declared.add(match[1]);
  }
  check(declared.size > 0, "WasmModule interface declares no functions");

  const wasmPath = join(distDir, "leptonica.wasm");
  check(existsSync(wasmPath), `missing ${wasmPath}`);
  const wasmBinary = readFileSync(wasmPath);
  const exported = new Set(
    WebAssembly.Module.exports(new WebAssembly.Module(wasmBinary)).map((entry) => entry.name),
  );

  // d.ts symbols carry the C-ABI underscore prefix (_pixCreateNoInit) while
  // wasm export names do not (pixCreateNoInit) — normalize before comparing.
  const missing = [...declared].filter((name) => !exported.has(name.replace(/^_/, "")));
  if (missing.length > 0) {
    fail(`d.ts declares symbols absent from wasm exports (${missing.length}): ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? ", …" : ""}`);
  }

  // Inverse direction (wasm exports ⊆ d.ts) is not asserted: emscripten
  // adds runtime exports (memory, __indirect_function_table) the d.ts does
  // not list. The forward direction is the drift that matters: a d.ts
  // claiming an API the wasm cannot provide.
  console.log(`check-exports OK (full-abi): ${declared.size} d.ts symbols all present in wasm exports`);
} else {
  console.log(`check-exports OK (default): ${symbolCount} symbols, ${DECODE_SYMBOL_PATTERNS.length} decode patterns absent`);
}
