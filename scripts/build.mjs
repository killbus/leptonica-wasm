import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { extractExportedFunctions } from "./gen-exports.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const depsRoot = join(repoRoot, "tmp", "deps");
const buildRoot = join(repoRoot, "tmp", "build");
const downloadsRoot = join(repoRoot, "tmp", "downloads");
const installRoot = join(buildRoot, "install");
const versions = JSON.parse(readFileSync(join(repoRoot, "vendor", "versions.json"), "utf8"));

function usage() {
  console.error("usage: node build.mjs [--full-abi] [--outdir <dir>] [--jobs <n>]");
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { stdio: "inherit", cwd: repoRoot, ...opts });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

function ghSlug(repo) {
  return repo.replace(/\.git$/, "").replace(/^https:\/\/github\.com\//, "");
}

function ensureSource(name, pin) {
  const srcDir = join(depsRoot, name);
  const marker = join(srcDir, ".pin-commit");
  if (existsSync(marker) && readFileSync(marker, "utf8").trim() === pin.commit && existsSync(join(srcDir, "CMakeLists.txt"))) {
    return;
  }
  rmSync(srcDir, { recursive: true, force: true });
  mkdirSync(srcDir, { recursive: true });
  const archive = join(downloadsRoot, `${name}-${pin.commit}.tar.gz`);
  if (!existsSync(archive)) {
    mkdirSync(downloadsRoot, { recursive: true });
    // Download to a .part temp first, then rename into place. A truncated
    // archive must not persist under the final name: existsSync() above
    // would skip re-download on later runs and every build would fail at
    // untar until the file is deleted by hand (M1 review, build-eng N2).
    const partial = `${archive}.part`;
    run("curl", ["-fsSL", "--retry", "3", "-o", partial, `https://codeload.github.com/${ghSlug(pin.repo)}/tar.gz/${pin.commit}`]);
    if (!existsSync(partial)) throw new Error(`curl did not produce ${partial}`);
    renameSync(partial, archive);
  }
  run("tar", ["-xzf", archive, "--strip-components=1", "-C", srcDir]);
  writeFileSync(marker, pin.commit + "\n");
}

const depConfigs = [
  {
    name: "zlib",
    extra: ["-DZLIB_BUILD_SHARED=OFF", "-DZLIB_BUILD_TESTING=OFF"],
  },
  {
    name: "libpng",
    extra: [
      "-DPNG_SHARED=OFF",
      "-DPNG_STATIC=ON",
      "-DPNG_TESTS=OFF",
      "-DPNG_TOOLS=OFF",
      `-DZLIB_LIBRARY=${join(installRoot, "lib", "libz.a")}`,
      `-DZLIB_INCLUDE_DIR=${join(installRoot, "include")}`,
    ],
  },
  {
    name: "libjpeg-turbo",
    extra: ["-DWITH_SIMD=OFF", "-DENABLE_SHARED=OFF"],
  },
  {
    name: "leptonica",
    extra: [
      "-DENABLE_WEBP=OFF",
      "-DENABLE_OPENJPEG=OFF",
      "-DENABLE_GIF=OFF",
      "-DENABLE_TIFF=OFF",
      `-DPNG_LIBRARY=${join(installRoot, "lib", "libpng16.a")}`,
      `-DPNG_PNG_INCLUDE_DIR=${join(installRoot, "include")}`,
      `-DZLIB_LIBRARY=${join(installRoot, "lib", "libz.a")}`,
      `-DZLIB_INCLUDE_DIR=${join(installRoot, "include")}`,
      `-DJPEG_LIBRARY=${join(installRoot, "lib", "libjpeg.a")}`,
      `-DJPEG_INCLUDE_DIR=${join(installRoot, "include")}`,
    ],
  },
];

function buildDep(dep, jobs, pin) {
  const buildDir = join(buildRoot, dep.name);
  const doneMarker = join(buildDir, ".done");
  // The marker records the inputs that produced this compiled tree. Checking
  // existence alone is not enough (M1 review, build-eng W1): after a pin bump
  // ensureSource() re-fetches sources but a stale .done would silently skip
  // recompilation and link the OLD library into the new build. Pin commit and
  // configure flags must both invalidate.
  const doneKey = JSON.stringify([pin.commit, dep.extra]);
  if (existsSync(doneMarker) && readFileSync(doneMarker, "utf8") === doneKey) return;
  const srcDir = join(depsRoot, dep.name);
  mkdirSync(buildDir, { recursive: true });
  run(
    "emcmake",
    [
      "cmake",
      "-G",
      "Ninja",
      "-DCMAKE_BUILD_TYPE=Release",
      `-DCMAKE_INSTALL_PREFIX=${installRoot}`,
      `-DCMAKE_PREFIX_PATH=${installRoot}`,
      "-DCMAKE_POLICY_VERSION_MINIMUM=3.5",
      ...dep.extra,
      srcDir,
    ],
    { cwd: buildDir },
  );
  const ninjaArgs = ["ninja", "install"];
  if (jobs > 0) ninjaArgs.push(`-j${jobs}`);
  run("emmake", ninjaArgs, { cwd: buildDir });
  writeFileSync(doneMarker, doneKey);
}

function nmDefinedSymbols(archivePath) {
  const result = spawnSync("emnm", ["--defined-only", archivePath], { encoding: "utf8", cwd: repoRoot });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`emnm ${archivePath} failed with exit code ${result.status}`);
  }
  const defined = new Set();
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]+)\s+([A-Z])\s+(\S+)$/.exec(line);
    if (match) defined.add(match[3]);
  }
  return defined;
}

function writeFullAbiExports() {
  const headerPath = join(depsRoot, "leptonica", "src", "allheaders.h");
  const names = extractExportedFunctions(readFileSync(headerPath, "utf8"));
  const defined = nmDefinedSymbols(join(installRoot, "lib", "libleptonica.a"));
  const filtered = names.filter((name) => defined.has(name.slice(1)));
  filtered.push("_malloc", "_free");
  filtered.sort();
  const exportsPath = join(buildRoot, "full-abi-exports.txt");
  writeFileSync(exportsPath, filtered.map((name) => `${name}\n`).join(""));
  return exportsPath;
}

function linkOutputs({ exportsPath, outDir, fullAbi }) {
  mkdirSync(outDir, { recursive: true });
  const emccArgs = [
    "cpp/bindings.cpp",
    "-o",
    join(outDir, "leptonica.mjs"),
    // -O3 + JS output makes binaryen minify wasm export names (da, ea, ...) via
    // metadce; the minify-export-names knob is an internal setting that emcc
    // refuses from the command line. The full-abi mode needs real C ABI names,
    // so it drops to -O2 (metadce off -> export names kept). Default mode is
    // embind-wrapped, so -O3 minification is safe there.
    fullAbi ? "-O2" : "-O3",
    "--no-entry",
    "-lembind",
    "--emit-symbol-map",
    `--emit-tsd=${join(outDir, "leptonica.d.ts")}`,
    "-sMODULARIZE=1",
    "-sEXPORT_ES6=1",
    "-sALLOW_MEMORY_GROWTH=1",
    "-sINITIAL_MEMORY=33554432",
    "-sENVIRONMENT=web,worker,node",
    `-I${join(installRoot, "include", "leptonica")}`,
    `-I${join(installRoot, "include")}`,
    // bindings.cpp includes leptonica's internal pix_internal.h (struct Pix
    // definition), which is not part of the installed header set.
    `-I${join(depsRoot, "leptonica", "src")}`,
    `-L${join(installRoot, "lib")}`,
  ];
  if (fullAbi) {
    emccArgs.push("-Wl,--whole-archive", "-lleptonica", "-Wl,--no-whole-archive", `-sEXPORTED_FUNCTIONS=@${resolve(exportsPath)}`);
  } else {
    emccArgs.push("-lleptonica");
  }
  emccArgs.push("-lpng16", "-ljpeg", "-lz");
  // bindings.cpp is C++ (embind, typeid/RTTI): link with the C++ driver so
  // libc++/libc++abi come in; plain emcc leaves __cxxabiv1 symbols undefined.
  run("em++", emccArgs);
  const wasm = readFileSync(join(outDir, "leptonica.wasm"));
  const js = readFileSync(join(outDir, "leptonica.mjs"));
  const wasmGzip = gzipSync(wasm, { level: 9 });
  const jsGzip = gzipSync(js, { level: 9 });
  return {
    wasmBytes: wasm.length,
    wasmGzipBytes: wasmGzip.length,
    jsBytes: js.length,
    jsGzipBytes: jsGzip.length,
    wasmSha256: createHash("sha256").update(wasm).digest("hex"),
  };
}

function parseArgs(argv) {
  const opts = { fullAbi: false, outDir: "dist", jobs: 0 };
  let outDirGiven = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--full-abi") {
      opts.fullAbi = true;
    } else if (arg === "--outdir") {
      opts.outDir = argv[i + 1] ?? null;
      if (opts.outDir === null) {
        usage();
        process.exit(2);
      }
      outDirGiven = true;
      i++;
    } else if (arg === "--jobs") {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value < 1) {
        usage();
        process.exit(2);
      }
      opts.jobs = value;
      i++;
    } else {
      usage();
      process.exit(2);
    }
  }
  // Without an explicit --outdir, full-abi must not silently overwrite the
  // default-mode artifacts in dist/ (M1 review, build-eng N2).
  if (opts.fullAbi && !outDirGiven) {
    opts.outDir = "dist/full-abi";
  }
  opts.outDir = resolve(opts.outDir);
  return opts;
}

const startedAt = Date.now();
const opts = parseArgs(process.argv.slice(2));
const fetchStartedAt = Date.now();
for (const dep of depConfigs) {
  ensureSource(dep.name, versions[dep.name]);
}
const fetchMs = Date.now() - fetchStartedAt;
for (const dep of depConfigs) {
  buildDep(dep, opts.jobs, versions[dep.name]);
}
let exportsPath = null;
let exportedFunctions = null;
if (opts.fullAbi) {
  exportsPath = writeFullAbiExports();
  exportedFunctions = readFileSync(exportsPath, "utf8").split("\n").filter((line) => line.length > 0).length;
}
const linkStartedAt = Date.now();
const sizes = linkOutputs({ exportsPath, outDir: opts.outDir, fullAbi: opts.fullAbi });
const report = {
  mode: opts.fullAbi ? "full-abi" : "default",
  // Provenance fields (M1 review, build-eng N4): the report must identify
  // which inputs produced it — trend comparisons and the M6 manifest need
  // pin + sdk + optimization level attached to every measurement.
  provenance: {
    sdkVersion: versions.emsdk?.version ?? null,
    dependencyPins: Object.fromEntries(depConfigs.map((dep) => [dep.name, versions[dep.name].commit])),
    optimizationLevel: opts.fullAbi ? "-O2" : "-O3",
  },
  wasmBytes: sizes.wasmBytes,
  wasmGzipBytes: sizes.wasmGzipBytes,
  jsBytes: sizes.jsBytes,
  jsGzipBytes: sizes.jsGzipBytes,
  wasmSha256: sizes.wasmSha256,
  exportedFunctions,
  timingMs: { fetch: fetchMs, link: Date.now() - linkStartedAt },
  wallMs: Date.now() - startedAt,
};
writeFileSync(join(opts.outDir, "build-report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(`build OK (${report.mode} mode): ${opts.outDir}`);
